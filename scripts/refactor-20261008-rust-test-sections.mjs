// Separate cfg(test) items from Rust production code for hashes and byte/line counts.
// This is a lexical section extractor, not a complexity or SLOC analyzer.
export function rustTestSections(source) {
  const ranges=[];
  const pattern=/#\[(?:cfg\(test\)|(?:tokio::)?test)\]/g;
  const closeBrace=start=>{
    let level=0, string=null, rawEnd=null, lineComment=false, blockDepth=0;
    for(let i=start;i<source.length;i++){
      const ch=source[i], next=source[i+1];
      if(lineComment){if(ch==='\n')lineComment=false;continue;}
      if(blockDepth){if(ch==='/'&&next==='*'){blockDepth++;i++;}else if(ch==='*'&&next==='/'){blockDepth--;i++;}continue;}
      if(rawEnd){if(source.startsWith(rawEnd,i)){i+=rawEnd.length-1;rawEnd=null;}continue;}
      if(string){if(ch==='\\'){i++;continue;}if(ch===string)string=null;continue;}
      if(ch==='/'&&next==='/'){lineComment=true;i++;continue;}
      if(ch==='/'&&next==='*'){blockDepth=1;i++;continue;}
      if(ch==='r') {const match=/^r(#{0,20})"/.exec(source.slice(i));if(match){rawEnd='"'+match[1];i+=match[0].length-1;continue;}}
      if(ch==='"'){string='"';continue;}
      if(ch==="'"&&/^'(?:\\.|[^'\r\n])'/.test(source.slice(i))){string="'";continue;}
      if(ch==='{')level++;
      if(ch==='}'&&--level===0)return i+1;
    }
    throw Error('Unterminated Rust test item');
  };
  for(const match of source.matchAll(pattern)){
    const start=source.lastIndexOf('\n',match.index)+1;
    const brace=source.indexOf('{',match.index+match[0].length);
    if(brace<0)throw Error('Rust test item has no body');
    const end=closeBrace(brace);
    ranges.push([start,source[end]==='\r'&&source[end+1]==='\n'?end+2:source[end]==='\n'?end+1:end]);
  }
  ranges.sort((a,b)=>a[0]-b[0]);const merged=[];
  for(const range of ranges){const prev=merged.at(-1);if(prev&&range[0]<=prev[1])prev[1]=Math.max(prev[1],range[1]);else merged.push([...range]);}
  return merged.map(([start,end])=>({start,end,text:source.slice(start,end)}));
}
