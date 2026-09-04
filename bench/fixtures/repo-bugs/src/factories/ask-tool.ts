import { Tool } from '@agentionai/agents/core';
import type { ToolInputSchema } from '@agentionai/agents/core';
import type { AskFn, AskRequest } from '../types.js';

export function createAskTool(ask: AskFn): Tool<string> {
  return new Tool<string>({
    name: 'ask_user',
    description: 'Ask the user a question when genuine ambiguity prevents you from proceeding. Do not use for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        options: { type: 'array', items: { type: 'string' }, description: 'Possible answers' },
        multiSelect: { type: 'boolean', description: 'Allow selecting multiple options' },
        allowFreeText: { type: 'boolean', description: 'Allow an Other answer' },
      },
      required: ['question'],
      additionalProperties: false,
    } as unknown as ToolInputSchema,
    execute: async (input) => {
      const request: AskRequest = {
        question: String(input.question ?? ''),
        ...(Array.isArray(input.options) ? { options: input.options.map(String) } : {}),
        ...(input.multiSelect === true ? { multiSelect: true } : {}),
        ...(input.allowFreeText === true ? { allowFreeText: true } : {}),
      };
      return ask(request);
    },
  });
}
