import express from 'express'
import path from 'path'
import cors from 'cors'
import http from 'http'
import basicAuth from 'express-basic-auth'
import { Server } from 'socket.io'
import logger from './utils/logger'
import { expressRequestLogger } from './utils/logger'
import { DataSource } from 'typeorm'
import { IChatFlow, IReactFlowNode, IChatMessage, IUploadFileSizeAndTypes } from './Interface'
import { getNodeModulesPackagePath, getEncryptionKey } from './utils'
import { getDataSource } from './DataSource'
import { NodesPool } from './NodesPool'
import { ChatFlow } from './database/entities/ChatFlow'
import { ChatMessage } from './database/entities/ChatMessage'
import { ChatflowPool } from './ChatflowPool'
import { CachePool } from './CachePool'
import { INodeParams } from 'flowise-components'
import { initializeRateLimiter } from './utils/rateLimit'
import { getAPIKeys } from './utils/apiKey'
import { sanitizeMiddleware, getCorsOptions, getAllowedIframeOrigins } from './utils/XSS'
import { Telemetry } from './utils/telemetry'
import flowiseApiV1Router from './routes'

declare global {
    namespace Express {
        interface Request {
            io?: Server
        }
    }
}

export class App {
    app: express.Application
    nodesPool: NodesPool
    chatflowPool: ChatflowPool
    cachePool: CachePool
    telemetry: Telemetry
    AppDataSource: DataSource = getDataSource()

    constructor() {
        this.app = express()
    }

    async initDatabase() {
        // Initialize database
        this.AppDataSource.initialize()
            .then(async () => {
                logger.info('📦 [server]: Data Source is being initialized!')

                // Run Migrations Scripts
                await this.AppDataSource.runMigrations({ transaction: 'each' })

                // Initialize nodes pool
                this.nodesPool = new NodesPool()
                await this.nodesPool.initialize()

                // Initialize chatflow pool
                this.chatflowPool = new ChatflowPool()

                // Initialize API keys
                await getAPIKeys()

                // Initialize encryption key
                await getEncryptionKey()

                // Initialize Rate Limit
                const AllChatFlow: IChatFlow[] = await getAllChatFlow()
                await initializeRateLimiter(AllChatFlow)

                // Initialize cache pool
                this.cachePool = new CachePool()

                // Initialize telemetry
                this.telemetry = new Telemetry()
                logger.info('📦 [server]: Data Source has been initialized!')
            })
            .catch((err) => {
                logger.error('❌ [server]: Error during Data Source initialization:', err)
            })
    }

    async config(socketIO?: Server) {
        // Limit is needed to allow sending/receiving base64 encoded string
        const flowise_file_size_limit = process.env.FLOWISE_FILE_SIZE_LIMIT ?? '50mb'
        this.app.use(express.json({ limit: flowise_file_size_limit }))
        this.app.use(express.urlencoded({ limit: flowise_file_size_limit, extended: true }))
        if (process.env.NUMBER_OF_PROXIES && parseInt(process.env.NUMBER_OF_PROXIES) > 0)
            this.app.set('trust proxy', parseInt(process.env.NUMBER_OF_PROXIES))

        // Allow access from specified domains
        this.app.use(cors(getCorsOptions()))

        // Allow embedding from specified domains.
        this.app.use((req, res, next) => {
            const allowedOrigins = getAllowedIframeOrigins()
            if (allowedOrigins == '*') {
                next()
            } else {
                const csp = `frame-ancestors ${allowedOrigins}`
                res.setHeader('Content-Security-Policy', csp)
                next()
            }
        })

        // Switch off the default 'X-Powered-By: Express' header
        this.app.disable('x-powered-by')

        // Add the expressRequestLogger middleware to log all requests
        this.app.use(expressRequestLogger)

        // Add the sanitizeMiddleware to guard against XSS
        this.app.use(sanitizeMiddleware)

        // Make io accessible to our router
        this.app.use((req, res, next) => {
            req.io = socketIO
            next()
        })

        if (process.env.FLOWISE_USERNAME && process.env.FLOWISE_PASSWORD) {
            const username = process.env.FLOWISE_USERNAME
            const password = process.env.FLOWISE_PASSWORD
            const basicAuthMiddleware = basicAuth({
                users: { [username]: password }
            })
            const whitelistURLs = [
                '/api/v1/verify/apikey/',
                '/api/v1/chatflows/apikey/',
                '/api/v1/public-chatflows',
                '/api/v1/public-chatbotConfig',
                '/api/v1/prediction/',
                '/api/v1/vector/upsert/',
                '/api/v1/node-icon/',
                '/api/v1/components-credentials-icon/',
                '/api/v1/chatflows-streaming',
                '/api/v1/chatflows-uploads',
                '/api/v1/openai-assistants-file',
                '/api/v1/feedback',
                '/api/v1/get-upload-file',
                '/api/v1/ip'
            ]
            this.app.use((req, res, next) => {
                if (req.url.includes('/api/v1/')) {
                    whitelistURLs.some((url) => req.url.includes(url)) ? next() : basicAuthMiddleware(req, res, next)
                } else next()
            })
        }

        this.app.use('/api/v1', flowiseApiV1Router)

        // ----------------------------------------
        // Serve UI static
        // ----------------------------------------

        const packagePath = getNodeModulesPackagePath('flowise-ui')
        const uiBuildPath = path.join(packagePath, 'build')
        const uiHtmlPath = path.join(packagePath, 'build', 'index.html')

        this.app.use('/', express.static(uiBuildPath))

        // All other requests not handled will return React app
        this.app.use((req, res) => {
            res.sendFile(uiHtmlPath)
        })
    }

    /**
     * Method that checks if uploads are enabled in the chatflow
     * @param {string} chatflowid
     */
    async getUploadsConfig(chatflowid: string): Promise<any> {
        const chatflow = await this.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowid
        })
        if (!chatflow) return `Chatflow ${chatflowid} not found`

        const uploadAllowedNodes = ['llmChain', 'conversationChain', 'mrklAgentChat', 'conversationalAgent']
        const uploadProcessingNodes = ['chatOpenAI', 'chatAnthropic', 'awsChatBedrock', 'azureChatOpenAI']

        const flowObj = JSON.parse(chatflow.flowData)
        const imgUploadSizeAndTypes: IUploadFileSizeAndTypes[] = []

        let isSpeechToTextEnabled = false
        if (chatflow.speechToText) {
            const speechToTextProviders = JSON.parse(chatflow.speechToText)
            for (const provider in speechToTextProviders) {
                if (provider !== 'none') {
                    const providerObj = speechToTextProviders[provider]
                    if (providerObj.status) {
                        isSpeechToTextEnabled = true
                        break
                    }
                }
            }
        }

        let isImageUploadAllowed = false
        const nodes: IReactFlowNode[] = flowObj.nodes

        /*
         * Condition for isImageUploadAllowed
         * 1.) one of the uploadAllowedNodes exists
         * 2.) one of the uploadProcessingNodes exists + allowImageUploads is ON
         */
        if (!nodes.some((node) => uploadAllowedNodes.includes(node.data.name))) {
            return {
                isSpeechToTextEnabled,
                isImageUploadAllowed: false,
                imgUploadSizeAndTypes
            }
        }

        nodes.forEach((node: IReactFlowNode) => {
            if (uploadProcessingNodes.indexOf(node.data.name) > -1) {
                // TODO: for now the maxUploadSize is hardcoded to 5MB, we need to add it to the node properties
                node.data.inputParams.map((param: INodeParams) => {
                    if (param.name === 'allowImageUploads' && node.data.inputs?.['allowImageUploads']) {
                        imgUploadSizeAndTypes.push({
                            fileTypes: 'image/gif;image/jpeg;image/png;image/webp;'.split(';'),
                            maxUploadSize: 5
                        })
                        isImageUploadAllowed = true
                    }
                })
            }
        })

        return {
            isSpeechToTextEnabled,
            isImageUploadAllowed,
            imgUploadSizeAndTypes
        }
    }

    /**
     * Method that add chat messages.
     * @param {Partial<IChatMessage>} chatMessage
     */
    async addChatMessage(chatMessage: Partial<IChatMessage>): Promise<ChatMessage> {
        const newChatMessage = new ChatMessage()
        Object.assign(newChatMessage, chatMessage)

        if (!newChatMessage.createdDate) newChatMessage.createdDate = new Date()

        const chatmessage = this.AppDataSource.getRepository(ChatMessage).create(newChatMessage)
        return await this.AppDataSource.getRepository(ChatMessage).save(chatmessage)
    }

    async stopApp() {
        try {
            const removePromises: any[] = []
            removePromises.push(this.telemetry.flush())
            await Promise.all(removePromises)
        } catch (e) {
            logger.error(`❌[server]: Flowise Server shut down error: ${e}`)
        }
    }
}

let serverApp: App | undefined

export async function getAllChatFlow(): Promise<IChatFlow[]> {
    return await getDataSource().getRepository(ChatFlow).find()
}

export async function start(): Promise<void> {
    serverApp = new App()

    const port = parseInt(process.env.PORT || '', 10) || 3000
    const server = http.createServer(serverApp.app)

    const io = new Server(server, {
        cors: getCorsOptions()
    })

    await serverApp.initDatabase()
    await serverApp.config(io)

    server.listen(port, () => {
        logger.info(`⚡️ [server]: Flowise Server is listening at ${port}`)
    })
}

export function getInstance(): App | undefined {
    return serverApp
}
