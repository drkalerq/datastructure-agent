import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
if(process.env.TEST_BLOCK_KNOWLEDGE_READ === 'true') {
 const read=fs.readFileSync; fs.readFileSync=function(path,...args){if(String(path).replaceAll(String.fromCharCode(92),'/').includes('content/knowledge/cards.json'))throw Error('test: knowledge unavailable');return read.call(this,path,...args);};syncBuiltinESMExports();
}
// Loaded explicitly by tests; never imported by the application.
const original=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 if(!String(url).startsWith('https://api.deepseek.com/'))return original(url,options);
 const request=JSON.parse(options.body);
 if(request.model === 'deepseek-chat' || request.thinking?.type !== 'disabled')throw Error('test: incompatible DeepSeek migration request');
 const content=request.messages.at(-1).content;
 const question=content.split('【学生本轮问题】').at(-1);
 if(question.includes('TEST_PAGE_CONTEXT')) {
  for(const value of ['"sourceVersion":"c-v1"','"activeLineId":"update-left"','"lineId":"update-left"','"active":true','"comparedValue":5','mid: 未计算','目标值: 7'])
    if(!content.includes(value))throw Error('Missing page context '+value);
  if(content.includes('【本轮提供的已核验知识卡】')||content.includes('卡片ID：'))throw Error('Unexpected knowledge prompt');
 }
 if(question.includes('TEST_TIMEOUT_BODY'))return{ok:true,json:()=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}))};
 if(question.includes('TEST_FAILURE'))return{ok:false,status:500};
 return{ok:true,json:async()=>({model:'local-test-provider',choices:[{message:{content:question.includes('TEST_EMPTY_OUTPUT')?'':'请观察当前区间和中点。'}}],
 ...(question.includes('TEST_UNKNOWN_USAGE')?{}:{usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})})};
};
