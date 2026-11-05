'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const roots = ['src','public/js','tests','scripts'];
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(full);
    else if(entry.isFile() && full.endsWith('.js') && full !== __filename) files.push(full);
  }
}
for(const root of roots) walk(root);
let failed=false;
for(const file of files.sort()) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0){failed=true;process.stderr.write(`${file}\n${result.stderr||result.stdout}`);}
}
if(failed) process.exit(1);
console.log(`Syntax check passed for ${files.length} JavaScript file(s).`);
