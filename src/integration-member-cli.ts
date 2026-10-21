#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {messagePath} from './message-contract.js';
import {runMemberRepairEntry} from './integration-member-entry.js';
import {runMemberRecomposition} from './member-recomposition.js';
export async function memberRepairMain(args:string[]){if(args.length!==3||!['prepare','run','reconcile-ended','recompose'].includes(args[0]!)||args[1]!=='--plan'||!messagePath(args[2]))throw new Error('member_repair_command_invalid');if(args[0]==='recompose')return runMemberRecomposition(args[2]!);return runMemberRepairEntry(args[2]!,args[0] as 'prepare'|'run'|'reconcile-ended');}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await memberRepairMain(process.argv.slice(2))));}catch(e){console.error(JSON.stringify({error:e instanceof Error?e.message:'member_repair_failed',automaticResend:false}));process.exitCode=1;}}
