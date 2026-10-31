import type {CliTool} from './cli-capabilities.js';

export const additionalPrograms=['kimi','gemini','opencode'] as const;
export type AdditionalProgram=typeof additionalPrograms[number];
export type AIProgram=CliTool|AdditionalProgram;
export const aiPrograms=['codex','claude',...additionalPrograms] as const;
export const isAdditionalProgram=(tool:string):tool is AdditionalProgram=>additionalPrograms.some(p=>p===tool);
export const programNames:Record<AIProgram,string>={codex:'Codex CLI',claude:'Claude Code CLI',kimi:'Kimi Code CLI',gemini:'Gemini CLI',opencode:'OpenCode'};
