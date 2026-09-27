import assert from 'node:assert/strict';
import { LOCAL_AI_PROVIDERS, localAiConfig, validateLocalAi, requestLocalAi, describeLocalAiImport, validateLocalAiImport } from '../src-tauri/renderer/src/local-ai-settings.js';
for (const provider of ['ollama', 'lmstudio']) {
  const definition = LOCAL_AI_PROVIDERS[provider];
  const config = localAiConfig({[definition.modelKey]: ' model-a '}, provider);
  assert.equal(config.model, 'model-a');
  assert.equal(config.endpoint, definition.endpoint);
  assert.equal(validateLocalAi(config), '');
  assert.match(validateLocalAi({...config, model:''}), /モデル/);
  for (const endpoint of ['file:///tmp', 'http://user:secret@localhost:1234/v1', 'http://localhost/v1?token=x', 'invalid']) {
    assert.notEqual(validateLocalAi({...config, endpoint}), '');
  }
}
assert.equal(localAiConfig({}, 'codex'), null);
const config = localAiConfig({aiOllamaModel:'model-a'}, 'ollama');
const oldFetch = globalThis.fetch;
try {
  let received;
  globalThis.fetch = async (url, options) => { received={url,body:JSON.parse(options.body),signal:options.signal}; return {ok:true,json:async()=>({models:[{id:'model-a'}]})}; };
  const controller = new AbortController();
  assert.deepEqual(await requestLocalAi('models', config, controller.signal), {models:[{id:'model-a'}]});
  assert.equal(received.url, '/api/ai/local/models');
  assert.deepEqual(received.body, config);
  assert.equal(received.signal, controller.signal);
  globalThis.fetch = async () => ({ok:false,status:503,json:async()=>({error:'サーバーを起動してください'})});
  await assert.rejects(requestLocalAi('test',config), /サーバーを起動/);
  globalThis.fetch = async () => ({ok:true,json:async()=>{throw Error('Invalid JSON')}});
  await assert.rejects(requestLocalAi('models',config), /応答/);
} finally { globalThis.fetch=oldFetch; }
console.log('PASS: local provider configuration, URL validation, request routing and server errors');

const active={aiProvider:'ollama',aiOllamaModel:'model-a',aiOllamaEndpoint:'http://localhost:11434/v1'};
assert.match(describeLocalAiImport({aiOllamaEndpoint:'http://other-host:11434/v1'},active).join(' '),/other-host/);
assert.match(describeLocalAiImport({aiProvider:'ollama'},active).join(' '),/localhost/);
assert.throws(()=>validateLocalAiImport({aiOllamaEndpoint:'file:///secret'},active),/URL/);
assert.throws(()=>validateLocalAiImport({aiOllamaModel:''},active),/モデル/);
validateLocalAiImport({aiOllamaEndpoint:'http://other-host:11434/v1'},active);
console.log('PASS: partial imports disclose destinations and validate effective local configuration');

assert.match(describeLocalAiImport({aiProvider:' ollama '},{...active,aiProvider:'none'}).join(' '),/localhost/);
assert.throws(()=>validateLocalAiImport({aiProvider:' ollama '},{...active,aiProvider:'none',aiOllamaModel:''}),/モデル/);
assert.equal(localAiConfig({},'__proto__'),null);
console.log('PASS: imported provider normalization matches saved settings');
