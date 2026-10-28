// 此程序只接受隔离安装目录，所有写入都在新建的合成验收账本中。
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const installed = process.argv[2];
const { apply } = await import(pathToFileURL(join(installed,"dist","src","dsh.js")).href);
const api = await import(pathToFileURL(join(installed,"dist","src","index.js")).href);
const root = await mkdtemp(join(tmpdir(),"moneypal-dsh-accept-"));
const definitions = []; let mode = "cancel"; let preview = ""; let before = "";
const hash = async () => {
  const walk = async (directory) => {
    const files = [];
    for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = join(directory,entry.name);
      if (entry.isDirectory()) files.push(...await walk(path)); else files.push(path);
    }
    return files;
  };
  const digest = createHash("sha256");
  for (const file of await walk(join(root,"default"))) { digest.update(file.slice(root.length)); digest.update(await readFile(file)); }
  return digest.digest("hex");
};
apply({tools:{register:definition=>definitions.push(definition)},systemPrompt:{section:()=>()=>{}},effect:fn=>fn(),userQuestions:{ask:async request=>{
  const item=request.questions[0];
  if(item.id==="confirm_finance_write") { assert.equal(await hash(),before); preview=item.detail; assert.match(preview,/验收午餐/u); }
  return {answers:[{id:item.id,selected:mode==="reject"?[]:[mode==="init"?"初始化":mode==="confirm"?"记入":"取消"]}]};
}}});
const call=(name,args={},child=false)=>definitions.find(item=>item.name===name).execute(args,{agent:{session:{header:{cwd:root,...(child?{parentSession:"acceptance-parent"}:{})}}},signal:new AbortController().signal});
try {
  assert.equal((await call("finance_initialize_ledger",{},true)).error.code,"write_requires_root_agent");
  assert.equal((await call("finance_initialize_ledger")).error.code,"cancelled");
  await assert.rejects(access(join(root,"default")));
  mode="init"; const initialized=await call("finance_initialize_ledger"); assert.equal(initialized.initialized,true);
  const year=initialized.year;
  const args={transactions:[{date:`${year}-08-25`,description:"验收午餐",postings:[{account:"Expenses:C-餐饮",amount:"12 CNY"},{account:"Assets:C-现金"}]}]};
  before=await hash();
  assert.equal((await call("finance_add_transactions",args,true)).error.code,"write_requires_root_agent"); assert.equal(await hash(),before);
  mode="reject"; assert.equal((await call("finance_add_transactions",args)).error.code,"cancelled"); assert.equal(await hash(),before);
  mode="cancel"; assert.equal((await call("finance_add_transactions",args)).error.code,"cancelled"); assert.equal(await hash(),before);
  mode="confirm"; const result=await call("finance_add_transactions",args); assert.ok(result.transactionText); assert.ok(preview.includes(result.transactionText.trim()));
  const query=await call("finance_query_register"); assert.equal(query.transactions.length,1); assert.equal(query.transactions[0].narration,"验收午餐");
  const transactionFile=await readFile(join(root,"default","transactions",`${year}.beancount`),"utf8"); assert.equal(transactionFile,result.transactionText);
  const balance=await call("finance_get_balance");
  const income=await call("finance_get_income_statement",{begin:`${year}-01-01`,end:`${year+1}-01-01`});
  const sheet=await call("finance_get_balance_sheet",{end:`${year+1}-01-01`});
  const accounts=await call("finance_list_accounts"); const journal=await call("finance_validate_journal"); assert.equal(journal.valid,true);
  const invalidDate=await call("finance_get_income_statement",{begin:`${year}-02-30`}); assert.equal(invalidDate.error.code,"invalid_request");
  const ordinaryDate=await call("finance_get_balance",{begin:"not-a-date"}); assert.ok(Array.isArray(ordinaryDate.accounts));
  const snapshot=await api.readBalanceSnapshot(root,`${year}-12-31`); assert.equal(snapshot.asOf,`${year}-12-31`);
  const runtime=await api.inspectRuntime(); assert.equal(runtime.compatible,true);
  console.log(JSON.stringify({status:"passed",runtime:{python:runtime.pythonVersion,beancount:runtime.beancountVersion,beanquery:runtime.beanqueryVersion},initialized,query,balance,income,sheet,accounts,journal,invalidDate,ordinaryDate,snapshot,transactionText:result.transactionText,checks:["初始化根权限及取消零写入","写入根权限、拒绝、取消零写入","预览期间摘要不变","确认后原文本写入及复查","六个只读工具与余额","普通日期与报表错误","兼容真实运行时"]}));
} finally { await rm(root,{recursive:true,force:true}); }
