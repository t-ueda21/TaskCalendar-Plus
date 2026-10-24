import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const dataKey=name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
export class FakeNode {
  constructor(root,attributes={}) {
    this.root=root;this.attributes={...attributes};this.dataset={};this.children=[];
    for(const [key,value] of Object.entries(attributes)) if(key.startsWith('data-')) this.dataset[dataKey(key)]=value;
    this.disabled=Object.hasOwn(attributes,'disabled');this.hidden=Object.hasOwn(attributes,'hidden');this.checked=false;
    this.isConnected=true;this.tabIndex=0;this.textContent='';this.title='';this._html='';this.styles={};this.classes=[];
    this.style={setProperty:(key,value)=>{this.styles[key]=String(value)}};
    this.classList={toggle:(key,value)=>{this.classes=this.classes.filter(item=>item!==key);if(value)this.classes.push(key);}};
  }
  set innerHTML(value) {
    this._html=String(value);this.children.forEach(node=>{node.isConnected=false});this.children=[];
    const expression=/<button\b([^>]*)>/g;let match;
    while((match=expression.exec(this._html))) {
      const attrs={};for(const attr of match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[attr[1]]=attr[2]??'';
      const node=new FakeNode(this.root,attrs);node.label=new FakeNode(this.root);node.label.hidden=/\bhidden\b/.test(this._html.slice(expression.lastIndex,this._html.indexOf('</button>',expression.lastIndex)));
      this.children.push(node);
    }
  }
  get innerHTML(){return this._html;}
  setAttribute(name,value){this.attributes[name]=String(value);if(name.startsWith('data-'))this.dataset[dataKey(name)]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  hasAttribute(name){return Object.hasOwn(this.attributes,name);}
  querySelector(selector){if(selector==='.summaryBarLabel')return this.label;if(selector==='[data-nav-label]')return this.navLabel;throw Error(`Unhandled child selector: ${selector}`);}
  focus(options){this.root.focusEvents.push({attributes:this.attributes,options});this.root.document.activeElement=this;}
  snapshot(){return {attributes:this.attributes,textContent:this.textContent,innerHTML:this._html,disabled:this.disabled,hidden:this.hidden,checked:this.checked,title:this.title,tabIndex:this.tabIndex,styles:this.styles,classes:this.classes,children:this.children.map(node=>({attributes:node.attributes,disabled:node.disabled,tabIndex:node.tabIndex,labelHidden:node.label?.hidden}))};}
}
export class FakeRoot {
  constructor(document) {
    this.document=document;this.nodes=new Map();this.focusEvents=[];
    const keys=['metrics','chart-title','legend','axis','bars','empty','numbers-title','numbers-hint','number-grid','tags','all-tags','tag-pager','tag-page-label','tag-status','insights','selected','period-label','current','future','range'];
    for(const key of keys)this.nodes.set(`[data-summary-${key}]`,new FakeNode(this,{[`data-summary-${key}`]:''}));
    for(const shift of [-1,1]) {
      const node=new FakeNode(this,{'data-summary-shift':String(shift)});node.navLabel=new FakeNode(this);this.nodes.set(`[data-summary-shift="${shift}"]`,node);
      this.nodes.set(`[data-summary-tag-page="${shift}"]`,new FakeNode(this,{'data-summary-tag-page':String(shift)}));
    }
    this.periods=['month','year'].map(value=>new FakeNode(this,{'data-summary-period':value}));
  }
  querySelector(selector){const node=this.nodes.get(selector);if(!node)throw Error(`Unhandled root selector: ${selector}`);return node;}
  querySelectorAll(selector){
    if(selector==='[data-summary-period]')return this.periods;
    const attrs=selector.split(',').map(part=>part.replace(/^\[|\]$/g,''));
    return [...this.nodes.values()].flatMap(node=>node.children).filter(node=>attrs.some(attr=>node.hasAttribute(attr)));
  }
  snapshot(){return {nodes:Object.fromEntries([...this.nodes].map(([key,value])=>[key,{...value.snapshot(),navLabel:value.navLabel?.textContent}])),periods:this.periods.map(node=>node.snapshot()),focusEvents:this.focusEvents};}
}

export async function createEnvironment(sourceRoot,contract,{instrument=true,transformRenderer}={}) {
  const base=path.resolve(sourceRoot,'src-tauri/renderer/src');
  const counts={number:0,date:0};const logs=[];const document={activeElement:null};
  const countedIntl=Object.create(Intl);
  countedIntl.NumberFormat=function(...args){counts.number++;return new Intl.NumberFormat(...args);};
  countedIntl.DateTimeFormat=function(...args){counts.date++;return new Intl.DateTimeFormat(...args);};
  const context=vm.createContext({Intl:instrument?countedIntl:Intl,document,structuredClone,console:{log:(...args)=>logs.push(args.join(' '))}},{name:'summary-offline-no-io',codeGeneration:{strings:false,wasm:false}});
  const modules=new Map();const allow=new Set(contract.safety.vm_modules);
  async function getModule(name) {
    if(modules.has(name))return modules.get(name);
    let module;
    if(name==='node:assert/strict') {
      module=new vm.SyntheticModule(['default'],function(){this.setExport('default',assert)},{context,identifier:name});
    } else if(name==='ui-utils.js') {
      const src=fs.readFileSync(path.join(base,name),'utf8');
      const selected=['escHtml','normalizeHexColor'].map(fn=>{const hit=src.match(new RegExp(`export function ${fn}\\([^]*?^\\}`,'m'));assert.ok(hit,`Missing audited pure utility ${fn}`);return hit[0];});
      module=new vm.SourceTextModule(`const DEFAULT_TAG_COLOR = "#2563eb";\n${selected.join('\n')}`,{context,identifier:name});
    } else {
      const isExistingTest=name==='@test-summary-model.mjs';
      assert.ok(isExistingTest||allow.has(name),`Unaudited module denied: ${name}`);
      let src=fs.readFileSync(isExistingTest?path.join(sourceRoot,'scripts/test-summary-model.mjs'):path.join(base,name),'utf8');
      if(name==='summary-renderer.js'){if(transformRenderer)src=transformRenderer(src);src+='\nexport { number, dateText, groupLabel, timeParts, timeMarkup, metricDetails };\n';}
      module=new vm.SourceTextModule(src,{context,identifier:name,
        importModuleDynamically:async(specifier,referrer)=>{const next=await getModule(resolve(specifier,referrer.identifier));if(next.status==='unlinked')await next.link(linker);if(next.status==='linked')await next.evaluate();return next;}});
    }
    modules.set(name,module);return module;
  }
  function resolve(specifier,referrer) {
    if(specifier==='node:assert/strict')return specifier;
    if(referrer==='@test-summary-model.mjs'&&specifier==='../src-tauri/renderer/src/summary-model.js')return 'summary-model.js';
    assert.ok(specifier.startsWith('./')||specifier.startsWith('../'),`Nonlocal import denied: ${specifier}`);
    const target=path.posix.normalize(path.posix.join(path.posix.dirname(referrer),specifier));
    assert.ok(!target.startsWith('../'),`Parent import denied: ${target}`);return target;
  }
  const linker=(specifier,referrer)=>getModule(resolve(specifier,referrer.identifier));
  async function load(name){const module=await getModule(name);if(module.status==='unlinked')await module.link(linker);if(module.status==='linked')await module.evaluate({timeout:30000});return module.namespace;}
  const renderer=await load('summary-renderer.js'),i18n=await load('i18n.js');
  return {renderer,i18n,document,counts,logs,context,load,resetCounts(){counts.number=0;counts.date=0;},sourceRoot};
}
export function serialize(value){return JSON.parse(JSON.stringify(value));}
export function outcome(operation){try{return {value:serialize(operation())}}catch(error){return {error:{name:error.name,message:error.message}}}}
