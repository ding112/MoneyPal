import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { integrity, sha256, verifyCore } from "./core-files.mjs";
const exec=promisify(execFile), root=fileURLToPath(new URL("..",import.meta.url));
const args={}, report={schemaVersion:1,milestone:"M2",status:"failed",product:"dsh-moneypal",productVersion:null,productCommit:null,coreVersion:null,coreIntegrity:null,candidateSha256:null,baselineSha256:null,platform:process.platform,arch:process.arch,node:process.version,python:null,requiredChecks:["输入来源及摘要","实际核心文件一致且无旧实现","隔离安装的类型入口","隔离运行时及新旧包完整财务与确认对照"],passedChecks:[],failedChecks:[],pendingChecks:["公共来源、CI、最低Node和真实DSH宿主留待后续，不计作本地通过"]};
let temporary, check=report.requiredChecks[0];
try {
  for(let index=2;index<process.argv.length;index++) {
    const key=process.argv[index];
    if(key==="--prepare-runtime") { assert.equal(args.prepare,undefined,"重复参数"); args.prepare=true; continue; }
    assert.ok(["--baseline","--candidate","--core","--reports","--python"].includes(key)&&!args[key.slice(2)]&&process.argv[index+1]&&!process.argv[index+1].startsWith("--"),"参数无效");
    args[key.slice(2)]=process.argv[++index];
  }
  for(const name of ["baseline","candidate","core","reports","python"]) assert.ok(args[name],`缺少 --${name}`);
  assert.ok(isAbsolute(args.python),"--python 必须是绝对路径");
  for(const name of ["baseline","candidate","core","reports"]) args[name]=resolve(args[name]);
  const records={};
  for(const name of ["baseline","candidate","core"]) {
    const bytes=await readFile(args[name]); const record=JSON.parse(await readFile(join(dirname(args[name]),"candidate.json"),"utf8"));
    assert.equal(record.schemaVersion,1); assert.equal(record.filename,basename(args[name])); assert.equal(record.sha256,sha256(bytes)); assert.equal(record.integrity,integrity(bytes));
    assert.equal(record.name,name==="core"?"@ding112/moneypal-core":"dsh-moneypal"); records[name]=record;
  }
  Object.assign(report,{productVersion:records.candidate.version,productCommit:records.candidate.sourceCommit,coreVersion:records.core.version,coreIntegrity:records.core.integrity,candidateSha256:records.candidate.sha256,baselineSha256:records.baseline.sha256}); report.passedChecks.push(check);
  temporary=await mkdtemp(join(tmpdir(),"moneypal-dsh-migration-")); const home=join(temporary,"home"); await mkdir(home);
  const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:join(home,"local"),XDG_DATA_HOME:join(home,"data"),npm_config_cache:join(temporary,"cache"),MONEYPAL_TEST_REQUIRE_RUNTIME:"1"}; delete env.MONEYPAL_PYTHON;
  const npm=(list,cwd)=>process.env.npm_execpath?exec(process.execPath,[process.env.npm_execpath,...list],{cwd,env,timeout:120000,maxBuffer:4*1024*1024}):exec(process.platform==="win32"?"npm.cmd":"npm",list,{cwd,env,timeout:120000,maxBuffer:4*1024*1024});
  const installed={};
  for(const name of ["baseline","candidate"]) {
    const directory=join(temporary,name); await mkdir(directory); await writeFile(join(directory,"package.json"),JSON.stringify({private:true,type:"module",name:`dsh-accept-${name}`}));
    await npm(["install","--ignore-scripts","--offline","--no-audit","--no-fund",args[name]],directory); installed[name]=join(directory,"node_modules","dsh-moneypal");
    const manifest=JSON.parse(await readFile(join(installed[name],"package.json"),"utf8")); assert.equal(manifest.name,"dsh-moneypal"); assert.equal(manifest.version,records[name].version);
    for(const field of ["dependencies","devDependencies","optionalDependencies","peerDependencies","bundledDependencies"]) assert.equal(manifest[field],undefined);
    for(const script of ["preinstall","install","postinstall"]) assert.equal(manifest.scripts?.[script],undefined);
  }
  check=report.requiredChecks[1];
  const provenance=JSON.parse(await readFile(join(installed.candidate,"CORE-PROVENANCE.json"),"utf8"));
  assert.equal(provenance.tarballSha256,records.core.sha256); assert.equal(provenance.integrity,records.core.integrity); assert.equal(provenance.sourceRecordSha256,records.core.sourceRecordSha256);
  const record=await verifyCore(join(installed.candidate,"dist","src","core"),records.core.sourceRecordSha256); assert.equal(record.sourceCommit,records.core.sourceCommit); assert.equal(record.version,records.core.version);
  await assert.rejects(readFile(join(installed.candidate,"dist","src","finance","engine.js"))); await assert.rejects(readFile(join(installed.candidate,"dist","src","init-ledger.js"))); report.passedChecks.push(check);
  check=report.requiredChecks[2];
  const consumer=join(temporary,"candidate");
  await writeFile(join(consumer,"consumer.ts"),'import { createLedgerEngine, createConfirmedTransactionWriter, initializeLedger, FinanceError, inspectRuntime, readBalanceSnapshot, type LedgerEngine, type Transaction, type TransactionCommit } from "dsh-moneypal";\nimport { apply } from "dsh-moneypal/dsh";\nvoid [createLedgerEngine,createConfirmedTransactionWriter,initializeLedger,FinanceError,inspectRuntime,readBalanceSnapshot,apply];\n');
  await writeFile(join(consumer,"tsconfig.json"),JSON.stringify({compilerOptions:{module:"NodeNext",moduleResolution:"NodeNext",target:"ES2024",noEmit:true,strict:true,skipLibCheck:true},include:["consumer.ts"]}));
  await exec(process.execPath,[join(root,"node_modules","typescript","bin","tsc"),"-p",join(consumer,"tsconfig.json")],{cwd:consumer,env}); report.passedChecks.push(check);
  check=report.requiredChecks[3];
  if(args.prepare) {
    try { await exec(process.execPath,[join(installed.candidate,"dist","src","main.js"),"setup-runtime","--python",args.python],{cwd:consumer,env,timeout:600000,maxBuffer:4*1024*1024}); }
    catch(error) { report.status="blocked"; throw error; }
  } else env.MONEYPAL_PYTHON=args.python;
  const results={};
  for(const name of ["baseline","candidate"]) {
    const result=await exec(process.execPath,[join(root,"scripts","accept-installed-dsh.mjs"),installed[name]],{cwd:join(temporary,name),env,timeout:120000,maxBuffer:4*1024*1024});
    results[name]=JSON.parse(result.stdout.trim()); assert.equal(results[name].status,"passed");
  }
  assert.deepEqual(results.candidate,results.baseline); report.python=results.candidate.runtime.python;
  report.results=results; report.passedChecks.push(check); report.status="passed";
} catch(error) { report.failedChecks.push(check); if(report.status!=="blocked") report.status="failed"; report.failure="必需检查失败，详见执行日志。"; console.error(`${check}: ${error.message}\n${error.stderr??""}`); process.exitCode=1; }
finally { if(temporary) await rm(temporary,{recursive:true,force:true}); if(args.reports) {await mkdir(args.reports,{recursive:true});await writeFile(join(args.reports,"dsh-migration.json"),`${JSON.stringify(report,null,2)}\n`);} console.log(JSON.stringify(report,null,2)); }
