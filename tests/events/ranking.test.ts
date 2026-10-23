import test from 'node:test';
import assert from 'node:assert/strict';
import { rankQueue,type RankItem } from '../../src/event-contract.js';
const at=Date.parse('2026-10-20T15:00:00Z');
const item=(n:number,changes:Partial<RankItem>={}):RankItem=>({item:n.toString(16).padStart(64,'0'),packet:n,H:n.toString(16).padStart(40,'0'),createdAt:'2026-10-20T14:00:00Z',current:true,waiting:[],target:'fixture',active:false,stage:'evaluate',classification:'ordinary',priority:0,estimatedCost:null,requires:[],evidence:[],...changes});
test('necessary exact-version upstream receives urgency while a blocked downstream takes no seat',()=>{
  const upstream=item(1),urgent=item(2,{classification:'adopted_main_incident',requires:[{item:upstream.item,H:upstream.H}],waiting:['upstream_not_complete']}),other=item(3,{classification:'verified_finish'});
  const ranked=rankQueue([urgent,other,upstream],[],at);assert.equal(ranked.selected?.item,upstream.item);assert.ok(ranked.selected?.reasons.some(x=>x.startsWith('necessary_upstream')));assert.equal(ranked.items.find(x=>x.item===urgent.item)?.selectable,false);assert.equal(ranked.rankingGrantsAuthority,false);
  urgent.requires[0]!.H='f'.repeat(40);assert.equal(rankQueue([urgent,other,upstream],[],at).selected?.item,other.item);
});
test('three urgent starts yield one eligible oldest waiting turn without preempting an active original',()=>{
  const urgent=item(1,{classification:'adopted_main_incident',createdAt:'2026-10-20T14:59:00Z'}),old=item(2),active=item(3,{active:true,createdAt:'2026-10-20T12:00:00Z'});
  const history=Array.from({length:3},()=>({item:urgent.item,class:'urgent' as const,selectedAt:'2026-10-20T14:59:10Z'}));
  assert.equal(rankQueue([old,urgent,active],history.slice(0,2),at).selected?.item,urgent.item);
  const ranked=rankQueue([old,urgent,active],history,at);assert.equal(ranked.selected?.item,old.item);assert.equal(ranked.selected?.fairnessTurn,true);assert.equal(ranked.policy.preemption,false);
  const olderReturn=item(4,{classification:'verified_return',createdAt:'2026-10-20T10:00:00Z'});assert.equal(rankQueue([olderReturn,old,urgent],history,at).selected?.item,old.item);
});
test('stale, finished and waiting work cannot become selectable through a high priority or old timestamp',()=>{
  const rows=[item(1,{current:false,priority:2}),item(2,{stage:'finished',classification:'adopted_main_incident'}),item(3,{waiting:['source_unavailable'],priority:2})];assert.equal(rankQueue(rows,[],at).selected,null);
  const ready=item(4);assert.equal(rankQueue([...rows,ready],[],at).selected?.item,ready.item);
});
test('waiting then recorded cost breaks equivalent priority ties; input history is unchanged',()=>{
  const older=item(1,{createdAt:'2026-10-20T13:00:00Z',estimatedCost:100}),cheap=item(2,{estimatedCost:1}),unknown=item(3),raw=JSON.stringify([older,cheap,unknown]);
  assert.equal(rankQueue([cheap,unknown,older],[],at).selected?.item,older.item);assert.deepEqual(rankQueue([unknown,cheap],[],at).items.map(x=>x.item),[cheap.item,unknown.item]);assert.equal(JSON.stringify([older,cheap,unknown]),raw);
});
