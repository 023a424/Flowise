import { DataSource } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { cloneDeep, get } from 'lodash'
import TurndownService from 'turndown'
import {
    AnalyticHandler,
    ICommonObject,
    ICondition,
    IFileUpload,
    IHumanInput,
    IMessage,
    IServerSideEventStreamer,
    convertChatHistoryToText,
    generateFollowUpPrompts
} from 'flowise-components'
import {
    IncomingAgentflowInput,
    INodeData,
    IReactFlowObject,
    IExecuteFlowParams,
    IFlowConfig,
    IAgentflowExecutedData,
    ExecutionState,
    IExecution,
    IChatMessage,
    ChatType,
    IReactFlowNode,
    IReactFlowEdge,
    IComponentNodes,
    INodeOverrides,
    IVariableOverride,
    INodeDirectedGraph
} from '../Interface'
import {
    CHAT_HISTORY_VAR_PREFIX,
    databaseEntities,
    FILE_ATTACHMENT_PREFIX,
    getAppVersion,
    getGlobalVariable,
    getStartingNode,
    getTelemetryFlowObj,
    QUESTION_VAR_PREFIX
} from '.'
import { ChatFlow } from '../database/entities/ChatFlow'
import { Variable } from '../database/entities/Variable'
import { replaceInputsWithConfig, constructGraphs, getAPIOverrideConfig } from '../utils'
import logger from './logger'
import { getErrorMessage } from '../errors/utils'
import { Execution } from '../database/entities/Execution'
import { utilAddChatMessage } from './addChatMesage'
import { CachePool } from '../CachePool'
import { ChatMessage } from '../database/entities/ChatMessage'

interface IWaitingNode {
    nodeId: string
    receivedInputs: Map<string, any>
    expectedInputs: Set<string>
    isConditional: boolean
    conditionalGroups: Map<string, string[]>
}

interface INodeQueue {
    nodeId: string
    data: any
    inputs: Record<string, any>
}

interface IProcessNodeOutputsParams {
    nodeId: string
    nodeName: string
    result: any
    humanInput?: IHumanInput
    graph: Record<string, string[]>
    nodes: IReactFlowNode[]
    edges: IReactFlowEdge[]
    nodeExecutionQueue: INodeQueue[]
    waitingNodes: Map<string, IWaitingNode>
    loopCounts: Map<string, number>
    abortController?: AbortController
}

interface IAgentFlowRuntime {
    state?: ICommonObject
    chatHistory?: IMessage[]
    form?: Record<string, any>
}

interface IExecuteNodeParams {
    nodeId: string
    reactFlowNode: IReactFlowNode
    nodes: IReactFlowNode[]
    graph: INodeDirectedGraph
    reversedGraph: INodeDirectedGraph
    incomingInput: IncomingAgentflowInput
    chatflow: ChatFlow
    chatId: string
    sessionId: string
    apiMessageId: string
    pastChatHistory: IMessage[]
    appDataSource: DataSource
    componentNodes: IComponentNodes
    cachePool: CachePool
    sseStreamer: IServerSideEventStreamer
    baseURL: string
    overrideConfig?: ICommonObject
    apiOverrideStatus?: boolean
    nodeOverrides?: INodeOverrides
    variableOverrides?: IVariableOverride[]
    uploadedFilesContent?: string
    fileUploads?: IFileUpload[]
    humanInput?: IHumanInput
    agentFlowExecutedData?: IAgentflowExecutedData[]
    agentflowRuntime: IAgentFlowRuntime
    abortController?: AbortController
    parentTraceIds?: ICommonObject
    analyticHandlers?: AnalyticHandler
}

interface IExecuteAgentFlowParams extends Omit<IExecuteFlowParams, 'incomingInput'> {
    incomingInput: IncomingAgentflowInput
}

const MAX_LOOP_COUNT = process.env.MAX_LOOP_COUNT ? parseInt(process.env.MAX_LOOP_COUNT) : 10

/**
 * Add execution to database
 * @param {DataSource} appDataSource
 * @param {string} agentflowId
 * @param {IAgentflowExecutedData[]} agentFlowExecutedData
 * @param {string} sessionId
 * @returns {Promise<Execution>}
 */
const addExecution = async (
    appDataSource: DataSource,
    agentflowId: string,
    agentFlowExecutedData: IAgentflowExecutedData[],
    sessionId: string
) => {
    const newExecution = new Execution()
    const bodyExecution = {
        agentflowId,
        state: 'INPROGRESS',
        sessionId,
        executionData: JSON.stringify(agentFlowExecutedData)
    }
    Object.assign(newExecution, bodyExecution)

    const execution = appDataSource.getRepository(Execution).create(newExecution)
    return await appDataSource.getRepository(Execution).save(execution)
}

/**
 * Update execution in database
 * @param {DataSource} appDataSource
 * @param {string} executionId
 * @param {Partial<IExecution>} data
 * @returns {Promise<void>}
 */
const updateExecution = async (appDataSource: DataSource, executionId: string, data?: Partial<IExecution>) => {
    const execution = await appDataSource.getRepository(Execution).findOneBy({
        id: executionId
    })

    if (!execution) {
        throw new Error(`Execution ${executionId} not found`)
    }

    const updateExecution = new Execution()
    const bodyExecution: ICommonObject = {}
    if (data && data.executionData) {
        bodyExecution.executionData = typeof data.executionData === 'string' ? data.executionData : JSON.stringify(data.executionData)
    }
    if (data && data.state) {
        bodyExecution.state = data.state

        if (data.state === 'STOPPED') {
            bodyExecution.stoppedDate = new Date()
        }
    }

    Object.assign(updateExecution, bodyExecution)

    appDataSource.getRepository(Execution).merge(execution, updateExecution)
    await appDataSource.getRepository(Execution).save(execution)
}

const _removeCredentialId = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj

    if (Array.isArray(obj)) {
        return obj.map((item) => _removeCredentialId(item))
    }

    const newObj: Record<string, any> = {}
    for (const [key, value] of Object.entries(obj)) {
        if (key === 'FLOWISE_CREDENTIAL_ID') continue
        newObj[key] = _removeCredentialId(value)
    }
    return newObj
}

export const resolveVariables = async (
    reactFlowNodeData: INodeData,
    question: string,
    form: Record<string, any>,
    flowConfig: IFlowConfig | undefined,
    availableVariables: Variable[],
    variableOverrides: IVariableOverride[],
    uploadedFilesContent: string,
    chatHistory: IMessage[],
    agentFlowExecutedData?: IAgentflowExecutedData[]
): Promise<INodeData> => {
    let flowNodeData = cloneDeep(reactFlowNodeData)
    const types = 'inputs'

    const resolveNodeReference = async (value: any): Promise<any> => {
        // If value is an array, process each element
        if (Array.isArray(value)) {
            return Promise.all(value.map((item) => resolveNodeReference(item)))
        }

        // If value is an object, process each property
        if (typeof value === 'object' && value !== null) {
            const resolvedObj: any = {}
            for (const [key, val] of Object.entries(value)) {
                resolvedObj[key] = await resolveNodeReference(val)
            }
            return resolvedObj
        }

        // If value is not a string, return as is
        if (typeof value !== 'string') return value

        const turndownService = new TurndownService()

        value = turndownService.turndown(value)

        const matches = value.match(/{{(.*?)}}/g)

        if (!matches) return value

        let resolvedValue = value
        for (const match of matches) {
            // Remove {{ }} and trim whitespace
            const reference = match.replace(/[{}]/g, '').trim()
            const variableFullPath = reference

            if (variableFullPath === QUESTION_VAR_PREFIX) {
                resolvedValue = resolvedValue.replace(match, question)
                resolvedValue = uploadedFilesContent ? `${uploadedFilesContent}\n\n${resolvedValue}` : resolvedValue
            }

            if (variableFullPath.startsWith('$form.')) {
                const variableValue = get(form, variableFullPath.replace('$form.', ''))
                if (variableValue != null) {
                    resolvedValue = resolvedValue.replace(match, variableValue)
                }
            }

            if (variableFullPath === FILE_ATTACHMENT_PREFIX) {
                resolvedValue = resolvedValue.replace(match, uploadedFilesContent)
            }

            if (variableFullPath === CHAT_HISTORY_VAR_PREFIX) {
                resolvedValue = resolvedValue.replace(match, convertChatHistoryToText(chatHistory))
            }

            if (variableFullPath.startsWith('$vars.')) {
                const vars = await getGlobalVariable(flowConfig, availableVariables, variableOverrides)
                const variableValue = get(vars, variableFullPath.replace('$vars.', ''))
                if (variableValue != null) {
                    resolvedValue = resolvedValue.replace(match, variableValue)
                }
            }

            if (variableFullPath.startsWith('$flow.') && flowConfig) {
                const variableValue = get(flowConfig, variableFullPath.replace('$flow.', ''))
                if (variableValue != null) {
                    resolvedValue = resolvedValue.replace(match, variableValue)
                }
            }

            // Find node data in executed data
            // sometimes turndown value returns a backslash like `llmAgentflow\_1`, remove the backslash
            const nodeData = agentFlowExecutedData?.find((data) => data.nodeId === variableFullPath.replace('\\', ''))
            if (nodeData && nodeData.data) {
                // Replace the reference with actual value
                const actualValue = (nodeData.data['output'] as ICommonObject)?.content
                resolvedValue = resolvedValue.replace(match, actualValue?.toString() ?? match)
            }
        }

        return resolvedValue
    }

    const getParamValues = async (paramsObj: ICommonObject) => {
        for (const key in paramsObj) {
            const paramValue = paramsObj[key]
            const isAcceptVariable = reactFlowNodeData.inputParams.find((param) => param.name === key)?.acceptVariable ?? false
            if (isAcceptVariable) {
                paramsObj[key] = await resolveNodeReference(paramValue)
            }
        }
    }

    const paramsObj = flowNodeData[types] ?? {}
    await getParamValues(paramsObj)

    return flowNodeData
}

/*
 * Gets all input connections for a specific node
 * @param {INode[]} nodes - Array of all nodes in the workflow
 * @param {IEdge[]} edges - Array of all edges (connections) in the workflow
 * @param {string} nodeId - ID of the node to get input connections for
 * @returns {IEdge[]} Array of input connections for the specified node
 *
 * @example
 * // For llmAgentflow_2 which has two inputs from llmAgentflow_0 and llmAgentflow_1
 * const connections = getNodeInputConnections(nodes, edges, 'llmAgentflow_2');
 * // Returns array of two edge objects connecting to llmAgentflow_2
 */
function getNodeInputConnections(edges: IReactFlowEdge[], nodeId: string): IReactFlowEdge[] {
    // Filter edges where target matches the nodeId
    const inputConnections = edges.filter((edge) => edge.target === nodeId)

    // Sort connections by sourceHandle to maintain consistent order
    // This is important for nodes that have multiple inputs that need to be processed in order
    inputConnections.sort((a, b) => {
        // Extract index from sourceHandle (e.g., "output-0" vs "output-1")
        const indexA = parseInt(a.sourceHandle.split('-').find((part) => !isNaN(parseInt(part))) || '0')
        const indexB = parseInt(b.sourceHandle.split('-').find((part) => !isNaN(parseInt(part))) || '0')
        return indexA - indexB
    })

    return inputConnections
}

/**
 * Analyzes node dependencies and sets up expected inputs
 */
function setupNodeDependencies(nodeId: string, edges: IReactFlowEdge[], nodes: IReactFlowNode[]): IWaitingNode {
    console.log(`\n🔍 Analyzing dependencies for node: ${nodeId}`)
    const inputConnections = getNodeInputConnections(edges, nodeId)
    const waitingNode: IWaitingNode = {
        nodeId,
        receivedInputs: new Map(),
        expectedInputs: new Set(),
        isConditional: false,
        conditionalGroups: new Map()
    }

    // Group inputs by their parent condition nodes
    const inputsByCondition = new Map<string | null, string[]>()

    for (const connection of inputConnections) {
        const sourceNode = nodes.find((n) => n.id === connection.source)
        if (!sourceNode) continue

        // Find if this input comes from a conditional branch
        const conditionParent = findConditionParent(connection.source, edges, nodes)

        if (conditionParent) {
            console.log(`  📌 Found conditional input from ${connection.source} (condition: ${conditionParent})`)
            waitingNode.isConditional = true
            const group = inputsByCondition.get(conditionParent) || []
            group.push(connection.source)
            inputsByCondition.set(conditionParent, group)
        } else {
            console.log(`  📌 Found required input from ${connection.source}`)
            waitingNode.expectedInputs.add(connection.source)
        }
    }

    // Set up conditional groups
    inputsByCondition.forEach((sources, conditionId) => {
        if (conditionId) {
            console.log(`  📋 Conditional group ${conditionId}: [${sources.join(', ')}]`)
            waitingNode.conditionalGroups.set(conditionId, sources)
        }
    })

    return waitingNode
}

/**
 * Finds the parent condition node for a given node, if any
 */
function findConditionParent(nodeId: string, edges: IReactFlowEdge[], nodes: IReactFlowNode[]): string | null {
    const currentNode = nodes.find((n) => n.id === nodeId)
    if (!currentNode) return null
    if (
        currentNode.data.name === 'conditionAgentflow' ||
        currentNode.data.name === 'conditionAgentAgentflow' ||
        currentNode.data.name === 'humanInputAgentflow'
    ) {
        return currentNode.id
    }

    let currentId = nodeId
    const visited = new Set<string>()

    let shouldContinue = true
    while (shouldContinue) {
        if (visited.has(currentId)) {
            shouldContinue = false
            continue
        }
        visited.add(currentId)

        const parentEdge = edges.find((edge) => edge.target === currentId)
        if (!parentEdge) {
            shouldContinue = false
            continue
        }

        const parentNode = nodes.find((n) => n.id === parentEdge.source)
        if (!parentNode) {
            shouldContinue = false
            continue
        }

        if (
            parentNode.data.name === 'conditionAgentflow' ||
            parentNode.data.name === 'conditionAgentAgentflow' ||
            parentNode.data.name === 'humanInputAgentflow'
        ) {
            return parentNode.id
        }

        currentId = parentNode.id
    }

    return null
}

/**
 * Checks if a node has received all required inputs
 */
function hasReceivedRequiredInputs(waitingNode: IWaitingNode): boolean {
    console.log(`\n✨ Checking inputs for node: ${waitingNode.nodeId}`)

    // Check non-conditional required inputs
    for (const required of waitingNode.expectedInputs) {
        const hasInput = waitingNode.receivedInputs.has(required)
        console.log(`  📊 Required input ${required}: ${hasInput ? '✅' : '❌'}`)
        if (!hasInput) return false
    }

    // Check conditional groups
    for (const [groupId, possibleSources] of waitingNode.conditionalGroups) {
        // Need at least one input from each conditional group
        const hasInputFromGroup = possibleSources.some((source) => waitingNode.receivedInputs.has(source))
        console.log(`  📊 Conditional group ${groupId}: ${hasInputFromGroup ? '✅' : '❌'}`)
        if (!hasInputFromGroup) return false
    }

    return true
}

/**
 * Determines which nodes should be ignored based on condition results
 * @param currentNode - The node being processed
 * @param result - The execution result from the node
 * @param edges - All edges in the workflow
 * @param nodeId - Current node ID
 * @returns Array of node IDs that should be ignored
 */
async function determineNodesToIgnore(
    currentNode: IReactFlowNode,
    result: any,
    humanInput: IHumanInput | undefined,
    edges: IReactFlowEdge[],
    nodeId: string
): Promise<string[]> {
    const ignoreNodeIds: string[] = []

    // Check if this is a decision node
    const isDecisionNode =
        currentNode.data.name === 'conditionAgentflow' ||
        currentNode.data.name === 'conditionAgentAgentflow' ||
        (currentNode.data.name === 'humanInputAgentflow' && humanInput)

    if (isDecisionNode && result.output?.conditions) {
        const outputConditions: ICondition[] = result.output.conditions

        // Find indexes of unfulfilled conditions
        const unfulfilledIndexes = outputConditions
            .map((condition: any, index: number) =>
                condition.isFullfilled === false || !Object.prototype.hasOwnProperty.call(condition, 'isFullfilled') ? index : -1
            )
            .filter((index: number) => index !== -1)

        // Find nodes to ignore based on unfulfilled conditions
        for (const index of unfulfilledIndexes) {
            const ignoreEdge = edges.find((edge) => edge.source === nodeId && edge.sourceHandle === `${nodeId}-output-${index}`)

            if (ignoreEdge) {
                ignoreNodeIds.push(ignoreEdge.target)
            }
        }
    }

    return ignoreNodeIds
}

/**
 * Process node outputs and handle branching logic
 */
async function processNodeOutputs({
    nodeId,
    nodeName,
    result,
    humanInput,
    graph,
    nodes,
    edges,
    nodeExecutionQueue,
    waitingNodes,
    loopCounts
}: IProcessNodeOutputsParams): Promise<{ humanInput?: IHumanInput }> {
    console.log(`\n🔄 Processing outputs from node: ${nodeId}`)

    let updatedHumanInput = humanInput

    const childNodeIds = graph[nodeId] || []
    console.log(`  👉 Child nodes: [${childNodeIds.join(', ')}]`)

    const currentNode = nodes.find((n) => n.id === nodeId)
    if (!currentNode) return { humanInput: updatedHumanInput }

    // Get nodes to ignore based on conditions
    const ignoreNodeIds = await determineNodesToIgnore(currentNode, result, humanInput, edges, nodeId)
    if (ignoreNodeIds.length) {
        console.log(`  ⏭️  Skipping nodes: [${ignoreNodeIds.join(', ')}]`)
    }

    for (const childId of childNodeIds) {
        if (ignoreNodeIds.includes(childId)) continue

        const childNode = nodes.find((n) => n.id === childId)
        if (!childNode) continue

        console.log(`  📝 Processing child node: ${childId}`)

        let waitingNode = waitingNodes.get(childId)

        if (!waitingNode) {
            console.log(`    🆕 First time seeing node ${childId} - analyzing dependencies`)
            waitingNode = setupNodeDependencies(childId, edges, nodes)
            waitingNodes.set(childId, waitingNode)
        }

        waitingNode.receivedInputs.set(nodeId, result)
        console.log(`    ➕ Added input from ${nodeId}`)

        // Check if node is ready to execute
        if (hasReceivedRequiredInputs(waitingNode)) {
            console.log(`    ✅ Node ${childId} ready for execution!`)
            waitingNodes.delete(childId)
            nodeExecutionQueue.push({
                nodeId: childId,
                data: combineNodeInputs(waitingNode.receivedInputs),
                inputs: Object.fromEntries(waitingNode.receivedInputs)
            })
        } else {
            console.log(`    ⏳ Node ${childId} still waiting for inputs`)
            console.log(`      Has: [${Array.from(waitingNode.receivedInputs.keys()).join(', ')}]`)
            console.log(`      Needs: [${Array.from(waitingNode.expectedInputs).join(', ')}]`)
            if (waitingNode.conditionalGroups.size > 0) {
                console.log('      Conditional groups:')
                waitingNode.conditionalGroups.forEach((sources, groupId) => {
                    console.log(`        ${groupId}: [${sources.join(', ')}]`)
                })
            }
        }
    }

    if (nodeName === 'loopAgentflow' && result.output?.nodeID) {
        console.log(`  🔄 Looping back to node: ${result.output.nodeID}`)

        const loopCount = (loopCounts.get(nodeId) || 0) + 1
        const maxLoop = result.output.maxLoopCount || MAX_LOOP_COUNT

        if (loopCount < maxLoop) {
            console.log(`    Loop count: ${loopCount}/${maxLoop}`)
            loopCounts.set(nodeId, loopCount)
            nodeExecutionQueue.push({
                nodeId: result.output.nodeID,
                data: result.output,
                inputs: {}
            })

            // Clear humanInput when looping to prevent it from being reused
            if (updatedHumanInput) {
                console.log(`    🧹 Clearing humanInput for loop iteration`)
                updatedHumanInput = undefined
            }
        } else {
            console.log(`    ⚠️ Maximum loop count (${maxLoop}) reached, stopping loop`)
        }
    }

    return { humanInput: updatedHumanInput }
}

/**
 * Combines inputs from multiple source nodes into a single input object
 * @param {Map<string, any>} receivedInputs - Map of inputs received from different nodes
 * @returns {any} Combined input data
 *
 * @example
 * const inputs = new Map();
 * inputs.set('node1', { json: { value: 1 }, text: 'Hello' });
 * inputs.set('node2', { json: { value: 2 }, text: 'World' });
 *
 * const combined = combineNodeInputs(inputs);
 *  Result:
 *  {
 *    json: {
 *      node1: { value: 1 },
 *      node2: { value: 2 }
 *    },
 *    text: 'Hello\nWorld'
 *  }
 */
function combineNodeInputs(receivedInputs: Map<string, any>): any {
    // Filter out null/undefined inputs
    const validInputs = new Map(Array.from(receivedInputs.entries()).filter(([_, value]) => value !== null && value !== undefined))

    if (validInputs.size === 0) {
        return null
    }

    if (validInputs.size === 1) {
        return Array.from(validInputs.values())[0]
    }

    // Initialize result object to store combined data
    const result: {
        json: any
        text?: string
        binary?: any
        error?: Error
    } = {
        json: {}
    }

    // Sort inputs by source node ID to ensure consistent ordering
    const sortedInputs = Array.from(validInputs.entries()).sort((a, b) => a[0].localeCompare(b[0]))

    for (const [sourceNodeId, inputData] of sortedInputs) {
        if (!inputData) continue

        try {
            // Handle different types of input data
            if (typeof inputData === 'object') {
                // Merge JSON data
                if (inputData.json) {
                    result.json = {
                        ...result.json,
                        [sourceNodeId]: inputData.json
                    }
                }

                // Combine text data if present
                if (inputData.text) {
                    result.text = result.text ? `${result.text}\n${inputData.text}` : inputData.text
                }

                // Merge binary data if present
                if (inputData.binary) {
                    result.binary = {
                        ...result.binary,
                        [sourceNodeId]: inputData.binary
                    }
                }

                // Handle error data
                if (inputData.error) {
                    result.error = inputData.error
                }
            } else {
                // Handle primitive data types
                result.json[sourceNodeId] = inputData
            }
        } catch (error) {
            // Log error but continue processing other inputs
            console.error(`Error combining input from node ${sourceNodeId}:`, error)
            result.error = error as Error
        }
    }

    // Special handling for text-only nodes
    if (Object.keys(result.json).length === 0 && result.text) {
        result.json = { text: result.text }
    }

    return result
}

/**
 * Executes a single node in the workflow
 * @param params - Parameters needed for node execution
 * @returns The result of the node execution
 */
const executeNode = async ({
    nodeId,
    reactFlowNode,
    graph,
    reversedGraph,
    incomingInput,
    chatflow,
    chatId,
    sessionId,
    apiMessageId,
    pastChatHistory,
    appDataSource,
    componentNodes,
    cachePool,
    sseStreamer,
    baseURL,
    overrideConfig = {},
    apiOverrideStatus = false,
    nodeOverrides = {},
    variableOverrides = [],
    uploadedFilesContent = '',
    fileUploads,
    humanInput,
    agentFlowExecutedData = [],
    agentflowRuntime,
    abortController,
    parentTraceIds,
    analyticHandlers
}: IExecuteNodeParams): Promise<{
    result: any
    shouldStop?: boolean
    agentFlowExecutedData?: IAgentflowExecutedData[]
}> => {
    try {
        if (abortController?.signal?.aborted) {
            throw new Error('Aborted')
        }

        // Stream progress event
        sseStreamer?.streamNextAgentFlowEvent(chatId, {
            nodeId,
            nodeLabel: reactFlowNode.data.label,
            status: 'INPROGRESS'
        })

        // Get node implementation
        const nodeInstanceFilePath = reactFlowNode.data.filePath as string
        const nodeModule = await import(nodeInstanceFilePath)
        const newNodeInstance = new nodeModule.nodeClass()

        // Prepare node data
        let flowNodeData = cloneDeep(reactFlowNode.data)

        // Apply config overrides if needed
        if (overrideConfig && apiOverrideStatus) {
            flowNodeData = replaceInputsWithConfig(flowNodeData, overrideConfig, nodeOverrides, variableOverrides)
        }

        // Get available variables and resolve them
        const availableVariables = await appDataSource.getRepository(Variable).find()

        // Prepare flow config
        const flowConfig: IFlowConfig = {
            chatflowid: chatflow.id,
            chatId,
            sessionId,
            apiMessageId,
            chatHistory: pastChatHistory,
            state: agentflowRuntime.state,
            ...overrideConfig
        }

        // Resolve variables in node data
        const reactFlowNodeData: INodeData = await resolveVariables(
            flowNodeData,
            incomingInput.question ?? '',
            incomingInput.form ?? agentflowRuntime.form ?? {},
            flowConfig,
            availableVariables,
            variableOverrides,
            uploadedFilesContent,
            pastChatHistory,
            agentFlowExecutedData
        )

        // Handle human input if present
        if (humanInput && nodeId === humanInput.startNodeId) {
            reactFlowNodeData.inputs = { humanInput }
            // Remove the stopped humanInput from execution data
            agentFlowExecutedData = agentFlowExecutedData.filter((execData) => execData.nodeId !== nodeId)
        }

        // Check if this is the last node for streaming purpose
        const isLastNode =
            !graph[nodeId] || graph[nodeId].length === 0 || (!humanInput && reactFlowNode.data.name === 'humanInputAgentflow')

        if (incomingInput.question && incomingInput.form) {
            throw new Error('Question and form cannot be provided at the same time')
        }

        let finalInput: string | Record<string, any> | undefined
        if (incomingInput.question) {
            // Prepare final question with uploaded content if any
            finalInput = uploadedFilesContent ? `${uploadedFilesContent}\n\n${incomingInput.question}` : incomingInput.question
        } else if (incomingInput.form) {
            finalInput = incomingInput.form
        }

        // Prepare run parameters
        const runParams = {
            chatId,
            sessionId,
            chatflowid: chatflow.id,
            apiMessageId: flowConfig.apiMessageId,
            logger,
            appDataSource,
            databaseEntities,
            componentNodes,
            cachePool,
            analytic: chatflow.analytic,
            uploads: fileUploads,
            baseURL,
            isLastNode,
            sseStreamer,
            pastChatHistory,
            agentflowRuntime,
            abortController,
            analyticHandlers,
            parentTraceIds
        }

        // Execute node
        const results = await newNodeInstance.run(reactFlowNodeData, finalInput, runParams)

        // Stop going through the current route if the node is a human task
        if (!humanInput && reactFlowNode.data.name === 'humanInputAgentflow') {
            const humanInputAction = {
                id: uuidv4(),
                mapping: {
                    approve: 'Proceed',
                    reject: 'Reject'
                },
                elements: [
                    { type: 'agentflowv2-approve-button', label: 'Proceed' },
                    { type: 'agentflowv2-reject-button', label: 'Reject' }
                ],
                data: {
                    nodeId,
                    nodeLabel: reactFlowNode.data.label,
                    input: results.input
                }
            }

            const newWorkflowExecutedData: IAgentflowExecutedData = {
                nodeId,
                nodeLabel: reactFlowNode.data.label,
                data: {
                    ...results,
                    output: {
                        ...results.output,
                        humanInputAction
                    }
                },
                previousNodeIds: reversedGraph[nodeId] || [],
                status: 'STOPPED'
            }
            agentFlowExecutedData.push(newWorkflowExecutedData)

            sseStreamer?.streamNextAgentFlowEvent(chatId, {
                nodeId,
                nodeLabel: reactFlowNode.data.label,
                status: 'STOPPED'
            })
            sseStreamer?.streamAgentFlowExecutedDataEvent(chatId, agentFlowExecutedData)
            sseStreamer?.streamAgentFlowEvent(chatId, 'STOPPED')

            sseStreamer?.streamActionEvent(chatId, humanInputAction)

            return { result: results, shouldStop: true, agentFlowExecutedData }
        }

        return { result: results, agentFlowExecutedData }
    } catch (error) {
        logger.error(`[server]: Error executing node ${nodeId}: ${getErrorMessage(error)}`)
        throw error
    }
}

/*
 * Function to traverse the flow graph and execute the nodes
 */
export const executeAgentFlow = async ({
    componentNodes,
    incomingInput,
    chatflow,
    chatId,
    appDataSource,
    telemetry,
    cachePool,
    sseStreamer,
    baseURL,
    isInternal,
    uploadedFilesContent,
    fileUploads,
    signal: abortController
}: IExecuteAgentFlowParams) => {
    console.log('\n🚀 Starting flow execution')

    const question = incomingInput.question
    const form = incomingInput.form
    let overrideConfig = incomingInput.overrideConfig ?? {}
    const uploads = incomingInput.uploads
    const userMessageDateTime = new Date()
    const chatflowid = chatflow.id
    const sessionId = incomingInput.sessionId ?? chatId
    const humanInput: IHumanInput | undefined = incomingInput.humanInput
    const apiMessageId = uuidv4()

    /*** Get chatflows and prepare data  ***/
    const flowData = chatflow.flowData
    const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
    const nodes = parsedFlowData.nodes
    const edges = parsedFlowData.edges
    const { graph, nodeDependencies } = constructGraphs(nodes, edges)
    const { graph: reversedGraph } = constructGraphs(nodes, edges, { isReversed: true })
    const startInputType = nodes.find((node) => node.data.name === 'startAgentflow')?.data.inputs?.startInputType as
        | 'chatInput'
        | 'formInput'
    if (!startInputType) {
        throw new Error('Start input type not found')
    }

    /*** Get API Config ***/
    const { nodeOverrides, variableOverrides, apiOverrideStatus } = getAPIOverrideConfig(chatflow)

    /*
    graph {
        startAgentflow_0: [ 'conditionAgentflow_0' ],
        conditionAgentflow_0: [ 'llmAgentflow_0', 'llmAgentflow_1' ],
        llmAgentflow_0: [ 'llmAgentflow_2' ],
        llmAgentflow_1: [ 'llmAgentflow_2' ],
        llmAgentflow_2: []
      }
    */

    /*
      nodeDependencies {
        startAgentflow_0: 0,
        conditionAgentflow_0: 1,
        llmAgentflow_0: 1,
        llmAgentflow_1: 1,
        llmAgentflow_2: 2
      }
    */

    let status: ExecutionState = 'INPROGRESS'
    let agentFlowExecutedData: IAgentflowExecutedData[] = []
    let newExecution: Execution
    const startingNodeIds: string[] = []

    // Initialize execution queue
    const nodeExecutionQueue: INodeQueue[] = []
    const waitingNodes: Map<string, IWaitingNode> = new Map()
    const loopCounts: Map<string, number> = new Map()

    // Initialize runtime state for new execution
    let agentflowRuntime: IAgentFlowRuntime = {
        state: {},
        chatHistory: [],
        form: {}
    }

    let previousExecution: Execution | undefined

    const previousExecutions = await appDataSource.getRepository(Execution).find({
        where: {
            sessionId,
            agentflowId: chatflowid
        },
        order: {
            createdDate: 'DESC'
        }
    })

    if (previousExecutions.length) {
        previousExecution = previousExecutions[0]
    }

    // If the start input type is form input, get the form values from the previous execution (form values are persisted in the same session)
    if (startInputType === 'formInput' && previousExecution) {
        const previousExecutionData = (JSON.parse(previousExecution.executionData) as IAgentflowExecutedData[]) ?? []

        const previousStartAgent = previousExecutionData.find((execData) => execData.data.name === 'startAgentflow')

        if (previousStartAgent) {
            const previousStartAgentOutput = previousStartAgent.data.output
            if (previousStartAgentOutput && typeof previousStartAgentOutput === 'object' && 'form' in previousStartAgentOutput) {
                agentflowRuntime.form = previousStartAgentOutput.form
            }
        }
    }

    // If it is human input, find the last checkpoint and resume
    if (humanInput?.startNodeId) {
        if (!previousExecution) {
            throw new Error(`No previous execution found for session ${sessionId}`)
        }

        if (previousExecution.state !== 'STOPPED') {
            throw new Error(
                `Cannot resume execution ${previousExecution.id} because it is in '${previousExecution.state}' state. ` +
                    `Only executions in 'STOPPED' state can be resumed.`
            )
        }

        const executionData = JSON.parse(previousExecution.executionData) as IAgentflowExecutedData[]

        // Verify that the humanInputAgentflow node exists in previous execution
        const humanInputNodeExists = executionData.some((data) => data.nodeId === humanInput.startNodeId)

        if (!humanInputNodeExists) {
            throw new Error(
                `Human Input node ${humanInput.startNodeId} not found in previous execution. ` +
                    `This could indicate an invalid resume attempt or a modified flow.`
            )
        }

        agentFlowExecutedData.push(...executionData)

        // Get last state
        const lastState = executionData[executionData.length - 1].data.state

        // Update agentflow runtime state
        agentflowRuntime.state = (lastState as ICommonObject) ?? {}

        // Update execution state to INPROGRESS
        await updateExecution(appDataSource, previousExecution.id, {
            state: 'INPROGRESS'
        })
        newExecution = previousExecution
        startingNodeIds.push(humanInput.startNodeId)
    } else {
        newExecution = await addExecution(appDataSource, chatflowid, agentFlowExecutedData, sessionId)
        const { startingNodeIds: startingNodeIdsFromFlow } = getStartingNode(nodeDependencies)
        startingNodeIds.push(...startingNodeIdsFromFlow)
    }

    // Add starting nodes to queue
    startingNodeIds.forEach((nodeId) => {
        nodeExecutionQueue.push({
            nodeId,
            data: {},
            inputs: {}
        })
    })

    const maxIterations = process.env.MAX_ITERATIONS ? parseInt(process.env.MAX_ITERATIONS) : 1000

    // Get chat history from ChatMessage table
    const pastChatHistory = (await appDataSource
        .getRepository(ChatMessage)
        .find({
            where: {
                chatflowid,
                chatId
            },
            order: {
                createdDate: 'ASC'
            }
        })
        .then((messages) =>
            messages.map((message) => ({
                content: message.content,
                role: message.role === 'userMessage' ? 'user' : 'assistant'
            }))
        )) as IMessage[]

    let iterations = 0
    let currentHumanInput = humanInput

    let analyticHandlers: AnalyticHandler | undefined
    let parentTraceIds: ICommonObject | undefined

    try {
        if (chatflow.analytic) {
            analyticHandlers = AnalyticHandler.getInstance({ inputs: {} } as any, {
                appDataSource,
                databaseEntities,
                componentNodes,
                analytic: chatflow.analytic,
                chatId
            })
            await analyticHandlers.init()
            parentTraceIds = await analyticHandlers.onChainStart(
                'Agentflow',
                form && Object.keys(form).length > 0 ? JSON.stringify(form) : question || ''
            )
        }
    } catch (error) {
        logger.error(`[server]: Error initializing analytic handlers: ${getErrorMessage(error)}`)
    }

    while (nodeExecutionQueue.length > 0 && status === 'INPROGRESS') {
        console.log(`\n▶️  Iteration ${iterations + 1}:`)
        console.log(`   Queue: [${nodeExecutionQueue.map((n) => n.nodeId).join(', ')}]`)

        if (iterations === 0) {
            sseStreamer?.streamAgentFlowEvent(chatId, 'INPROGRESS')
        }

        if (iterations++ > maxIterations) {
            throw new Error('Maximum iteration limit reached')
        }

        const currentNode = nodeExecutionQueue.shift()
        if (!currentNode) continue

        const reactFlowNode = nodes.find((nd) => nd.id === currentNode.nodeId)
        if (!reactFlowNode || reactFlowNode === undefined || reactFlowNode.data.name === 'stickyNoteAgentflow') continue

        let nodeResult
        try {
            // Check for abort signal early in the loop
            if (abortController?.signal?.aborted) {
                throw new Error('Aborted')
            }

            console.log(`   🎯 Executing node: ${reactFlowNode?.data.label}`)

            // Execute current node
            const executionResult = await executeNode({
                nodeId: currentNode.nodeId,
                reactFlowNode,
                nodes,
                graph,
                reversedGraph,
                incomingInput,
                chatflow,
                chatId,
                sessionId,
                apiMessageId,
                pastChatHistory,
                appDataSource,
                componentNodes,
                cachePool,
                sseStreamer,
                baseURL,
                overrideConfig,
                apiOverrideStatus,
                nodeOverrides,
                variableOverrides,
                uploadedFilesContent,
                fileUploads,
                humanInput: currentHumanInput,
                agentFlowExecutedData,
                agentflowRuntime,
                abortController,
                parentTraceIds,
                analyticHandlers
            })

            if (executionResult.agentFlowExecutedData) {
                agentFlowExecutedData = executionResult.agentFlowExecutedData
            }

            if (executionResult.shouldStop) {
                status = 'STOPPED'
                break
            }

            nodeResult = executionResult.result

            // Add execution data
            agentFlowExecutedData.push({
                nodeId: currentNode.nodeId,
                nodeLabel: reactFlowNode.data.label,
                data: nodeResult,
                previousNodeIds: reversedGraph[currentNode.nodeId],
                status: 'FINISHED'
            })

            sseStreamer?.streamNextAgentFlowEvent(chatId, {
                nodeId: currentNode.nodeId,
                nodeLabel: reactFlowNode.data.label,
                status: 'FINISHED'
            })

            sseStreamer?.streamAgentFlowExecutedDataEvent(chatId, agentFlowExecutedData)

            // Add to agentflow runtime state
            if (nodeResult && nodeResult.state) {
                agentflowRuntime.state = nodeResult.state
            }

            if (nodeResult && nodeResult.chatHistory) {
                agentflowRuntime.chatHistory = [...(agentflowRuntime.chatHistory ?? []), ...nodeResult.chatHistory]
            }

            if (nodeResult && nodeResult.output && nodeResult.output.form) {
                agentflowRuntime.form = nodeResult.output.form
            }

            // Process node outputs and handle branching
            const processResult = await processNodeOutputs({
                nodeId: currentNode.nodeId,
                nodeName: reactFlowNode.data.name,
                result: nodeResult,
                humanInput: currentHumanInput,
                graph,
                nodes,
                edges,
                nodeExecutionQueue,
                waitingNodes,
                loopCounts,
                abortController
            })

            console.log('processResult', processResult)

            // Update humanInput if it was changed
            if (processResult.humanInput !== currentHumanInput) {
                currentHumanInput = processResult.humanInput
            }
        } catch (error) {
            const isAborted = getErrorMessage(error).includes('Aborted')
            const errorStatus = isAborted ? 'TERMINATED' : 'ERROR'
            const errorMessage = isAborted ? 'Flow execution was cancelled' : getErrorMessage(error)

            status = errorStatus

            // Add error info to execution data
            agentFlowExecutedData.push({
                nodeId: currentNode.nodeId,
                nodeLabel: reactFlowNode.data.label,
                previousNodeIds: reversedGraph[currentNode.nodeId] || [],
                data: {
                    id: currentNode.nodeId,
                    name: reactFlowNode.data.name,
                    error: errorMessage
                },
                status: errorStatus
            })

            // Stream events to client
            sseStreamer?.streamNextAgentFlowEvent(chatId, {
                nodeId: currentNode.nodeId,
                nodeLabel: reactFlowNode.data.label,
                status: errorStatus,
                error: isAborted ? undefined : errorMessage
            })

            sseStreamer?.streamAgentFlowExecutedDataEvent(chatId, agentFlowExecutedData)

            // Update execution record in database
            await updateExecution(appDataSource, newExecution.id, {
                executionData: JSON.stringify(agentFlowExecutedData),
                state: errorStatus
            })

            sseStreamer?.streamAgentFlowEvent(chatId, errorStatus)

            if (parentTraceIds && analyticHandlers) {
                await analyticHandlers.onChainError(parentTraceIds, errorMessage, true)
            }

            throw new Error(errorMessage)
        }

        console.log(`/////////////////////////////////////////////////////////////////////////////`)
    }

    // check if there is any status stopped from agentFlowExecutedData
    const terminatedNode = agentFlowExecutedData.find((data) => data.status === 'TERMINATED')
    const errorNode = agentFlowExecutedData.find((data) => data.status === 'ERROR')
    const stoppedNode = agentFlowExecutedData.find((data) => data.status === 'STOPPED')

    if (terminatedNode) {
        status = 'TERMINATED'
    } else if (errorNode) {
        status = 'ERROR'
    } else if (stoppedNode) {
        status = 'STOPPED'
    } else {
        status = 'FINISHED'
    }

    await updateExecution(appDataSource, newExecution.id, {
        executionData: JSON.stringify(agentFlowExecutedData),
        state: status
    })

    sseStreamer?.streamAgentFlowEvent(chatId, status)

    console.log(`\n🏁 Flow execution completed`)
    console.log(`   Status: ${status}`)

    // check if last agentFlowExecutedData.data.output contains the key "content"
    const lastNodeOutput = agentFlowExecutedData[agentFlowExecutedData.length - 1].data?.output as ICommonObject | undefined
    const content = (lastNodeOutput?.content as string) ?? ' '

    // remove credentialId from agentFlowExecutedData
    agentFlowExecutedData = agentFlowExecutedData.map((data) => _removeCredentialId(data))

    if (parentTraceIds && analyticHandlers) {
        await analyticHandlers.onChainEnd(parentTraceIds, content, true)
    }

    // Find the previous chat message with the same session/chat id and remove the action
    if (humanInput && Object.keys(humanInput).length) {
        let query = await appDataSource
            .getRepository(ChatMessage)
            .createQueryBuilder('chat_message')
            .where('chat_message.chatId = :chatId', { chatId })
            .orWhere('chat_message.sessionId = :sessionId', { sessionId })
            .orderBy('chat_message.createdDate', 'DESC')
            .getMany()

        for (const result of query) {
            if (result.action) {
                try {
                    const newChatMessage = new ChatMessage()
                    Object.assign(newChatMessage, result)
                    newChatMessage.action = null
                    const cm = await appDataSource.getRepository(ChatMessage).create(newChatMessage)
                    await appDataSource.getRepository(ChatMessage).save(cm)
                    break
                } catch (e) {
                    // error converting action to JSON
                }
            }
        }
    }

    let finalUserInput = incomingInput.question || ' '

    if (startInputType === 'chatInput') {
        finalUserInput = question || humanInput?.feedback || ' '
    } else if (startInputType === 'formInput') {
        if (form) {
            finalUserInput = Object.entries(form || {})
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n')
        } else {
            finalUserInput = question || humanInput?.feedback || ' '
        }
    }

    const userMessage: Omit<IChatMessage, 'id'> = {
        role: 'userMessage',
        content: finalUserInput,
        chatflowid,
        chatType: isInternal ? ChatType.INTERNAL : ChatType.EXTERNAL,
        chatId,
        sessionId,
        createdDate: userMessageDateTime,
        fileUploads: uploads ? JSON.stringify(fileUploads) : undefined,
        leadEmail: incomingInput.leadEmail,
        executionId: newExecution.id
    }
    await utilAddChatMessage(userMessage, appDataSource)

    const apiMessage: Omit<IChatMessage, 'createdDate'> = {
        id: apiMessageId,
        role: 'apiMessage',
        content: content,
        chatflowid,
        chatType: isInternal ? ChatType.INTERNAL : ChatType.EXTERNAL,
        chatId,
        sessionId,
        executionId: newExecution.id
    }
    if (lastNodeOutput?.sourceDocuments) apiMessage.sourceDocuments = JSON.stringify(lastNodeOutput.sourceDocuments)
    if (lastNodeOutput?.usedTools) apiMessage.usedTools = JSON.stringify(lastNodeOutput.usedTools)
    if (lastNodeOutput?.fileAnnotations) apiMessage.fileAnnotations = JSON.stringify(lastNodeOutput.fileAnnotations)
    if (lastNodeOutput?.artifacts) apiMessage.artifacts = JSON.stringify(lastNodeOutput.artifacts)
    if (chatflow.followUpPrompts) {
        const followUpPromptsConfig = JSON.parse(chatflow.followUpPrompts)
        const followUpPrompts = await generateFollowUpPrompts(followUpPromptsConfig, apiMessage.content, {
            chatId,
            chatflowid,
            appDataSource,
            databaseEntities
        })
        if (followUpPrompts?.questions) {
            apiMessage.followUpPrompts = JSON.stringify(followUpPrompts.questions)
        }
    }
    if (lastNodeOutput?.humanInputAction && Object.keys(lastNodeOutput.humanInputAction).length)
        apiMessage.action = JSON.stringify(lastNodeOutput.humanInputAction)

    const chatMessage = await utilAddChatMessage(apiMessage, appDataSource)

    logger.debug(`[server]: Finished running agentflow ${chatflowid}`)

    await telemetry.sendTelemetry('prediction_sent', {
        version: await getAppVersion(),
        chatflowId: chatflowid,
        chatId,
        type: isInternal ? ChatType.INTERNAL : ChatType.EXTERNAL,
        flowGraph: getTelemetryFlowObj(nodes, edges)
    })

    /*** Prepare response ***/
    let result: ICommonObject = {}
    result.text = content
    result.question = incomingInput.question // return the question in the response, this is used when input text is empty but question is in audio format
    result.form = form
    result.chatId = chatId
    result.chatMessageId = chatMessage?.id
    result.followUpPrompts = JSON.stringify(apiMessage.followUpPrompts)
    result.executionId = newExecution.id
    result.agentFlowExecutedData = agentFlowExecutedData

    if (sessionId) result.sessionId = sessionId

    return result
}
