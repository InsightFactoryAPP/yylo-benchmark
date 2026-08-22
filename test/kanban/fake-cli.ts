import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedConfig } from '../../src/config/index.js';

export interface FakeState { tasks: Record<string, Record<string, unknown>>; revisions: Record<string, string>; records?: string[]; mutateDuringRead?: boolean; badReceipt?: boolean; omitReceipt?: boolean }

export async function installFakeKanban(root: string, state: FakeState): Promise<{ loaded: LoadedConfig; statePath: string; callsPath: string }> {
  const statePath = path.join(root, 'state.json'); const callsPath = path.join(root, 'calls.jsonl'); const script = path.join(root, 'fake-kanban.mjs');
  await writeFile(statePath, JSON.stringify(state), 'utf8'); await writeFile(callsPath, '', 'utf8');
  await writeFile(script, `#!/usr/bin/env node
import fs from 'node:fs';
const statePath=${JSON.stringify(statePath)}, callsPath=${JSON.stringify(callsPath)};
const rawArgs=process.argv.slice(2); fs.appendFileSync(callsPath, JSON.stringify(rawArgs)+'\\n');
const args=rawArgs[0]==='-f'&&rawArgs[1]==='json'?rawArgs.slice(2):rawArgs;
const state=JSON.parse(fs.readFileSync(statePath,'utf8')); const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const value=(flag)=>{const i=args.indexOf(flag); return i<0?undefined:args[i+1]};
if(args[0]==='--version'){console.log('yylo-ledger 0.1.0rc1');process.exit(0)}
const command=args[0];
if(command==='get') { const id=args[1]; const task=state.tasks[id]; if(!task)process.exit(4); console.log(JSON.stringify([task])); process.exit(0); }
if(command==='history') { const id=args[1]; state.historyCalls=(state.historyCalls||0)+1; if(state.mutateDuringRead&&state.historyCalls>=2){state.revisions[id]='f'.repeat(64);state.mutateDuringRead=false} save(); console.log(JSON.stringify([{task_id:id,operation:'update',after_sha256:state.revisions[id],event_id:'evt'}]));process.exit(0); }
if(command==='search') { const field=value('--field')||''; const [name,...rest]=field.split('='); const wanted=rest.join('='); const key=name?.replace('benchmark.',''); const tag=value('--tag'); const tasks=Object.values(state.tasks).filter(t=>(!tag||t.feature_tags?.includes(tag))&&t.fields?.benchmark?.[key]===wanted); console.log(JSON.stringify({tasks,summary:{count:tasks.length}}));process.exit(0); }
if(command==='create') {
 const benchmark=JSON.parse((value('--field')||'benchmark={}').slice('benchmark='.length));
 if(Object.values(state.tasks).some(t=>t.fields?.benchmark?.record_id===benchmark.record_id)){console.error('duplicate task');process.exit(5)}
 const id='REC'+String((state.records||[]).length+1); const now='2026-08-12T01:00:00Z';
 const task={id,status:value('--status')||'backlog',body:'title:'+value('--title')+'\\n\\n'+value('--body'),last_modified:now,commit_hash:null,feature_tags:[value('--tags')],related_tasks:[value('--related-tasks')],blocked_by:[],fields:{benchmark}};
 const after=(String((state.records||[]).length+2).padStart(64,'a')).slice(-64); state.tasks[id]=task;state.revisions[id]=after;state.records=[...(state.records||[]),id];save();
 const receipt={task_id:id,operation:'create',before_sha256:null,after_sha256:after,ledger_event_id:'event-'+id,changed_paths:['/'],persisted_path:'tasks/'+id+'.md'};
 if(state.badReceipt)receipt.after_sha256='0'.repeat(64); if(!state.omitReceipt)fs.writeFileSync(value('--receipt-file'),JSON.stringify(receipt)); console.log(JSON.stringify([task]));process.exit(0);
}
if(command==='update') {
 const id=args[1], expected=value('--expected-revision'); if(expected!==state.revisions[id]){console.error('stale task revision');process.exit(6)}
 const before=state.revisions[id], after='e'.repeat(64); state.tasks[id].fields.benchmark=JSON.parse(value('--field').slice('benchmark='.length));state.revisions[id]=after;save();
 const receipt={task_id:id,operation:'update',before_sha256:before,after_sha256:after,ledger_event_id:'event-update',changed_paths:['/fields/benchmark'],persisted_path:'tasks/'+id+'.md'};fs.writeFileSync(value('--receipt-file'),JSON.stringify(receipt));console.log(JSON.stringify([state.tasks[id]]));process.exit(0);
}
process.exit(8);
`, 'utf8'); await chmod(script, 0o700);
  return { statePath, callsPath, loaded: { config: { schema_version: 'juno_benchmark_config.v1', repository_id: 'root', kanban: { executable: process.execPath, arguments: [script] } }, configPath: null, projectRoot: root } };
}

export function optedInTask(id = 'CASE1'): Record<string, unknown> {
  return { id, status: 'done', body: 'Fix it.', last_modified: '2026-08-12T00:00:00Z', commit_hash: 'b'.repeat(40), feature_tags: ['benchmark-case'], related_tasks: [], blocked_by: [], fields: { benchmark: { schema_version: 'juno_benchmark_case_ref.v1', eligible: true, case_version: 1, repository_id: 'root', base_commit: 'a'.repeat(40), category: 'backend', grader_profile: 'focused-tests', wiki_paths: [] } } };
}
