'use strict';

const fs = require('node:fs');
const path = require('node:path');
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile() && fullPath.endsWith('.ejs')) files.push(fullPath);
  }
}

function validateIncludes(source, file) {
  const includePattern = /include\(\s*['\"]([^'\"]+)['\"]/g;
  for (const match of source.matchAll(includePattern)) {
    const target = path.resolve(path.dirname(file), match[1] + (match[1].endsWith('.ejs') ? '' : '.ejs'));
    if (!target.startsWith(path.resolve(process.cwd(), 'views') + path.sep) || !fs.existsSync(target)) {
      throw new Error(`${path.relative(process.cwd(), file)}: missing or invalid EJS include ${match[1]}`);
    }
  }
}

function compileSyntax(source, file) {
  const matcher = /<%([=#-]?)([\s\S]*?)%>/g;
  let cursor = 0;
  let generated = 'let __output = ""; with (locals || {}) {\n';
  for (const match of source.matchAll(matcher)) {
    const literal = source.slice(cursor, match.index);
    generated += `__output += ${JSON.stringify(literal)};\n`;
    const marker = match[1];
    const body = match[2];
    if (marker === '=' || marker === '-') generated += `__output += String((${body}) ?? "");\n`;
    else if (marker !== '#') generated += `${body}\n`;
    cursor = match.index + match[0].length;
  }
  generated += `__output += ${JSON.stringify(source.slice(cursor))};\n}\nreturn __output;`;
  try { new Function('locals', generated); }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
}

walk(path.join(process.cwd(), 'views'));
let failed = false;
for (const file of files.sort()) {
  try { const source = fs.readFileSync(file, 'utf8'); validateIncludes(source, file); compileSyntax(source, path.relative(process.cwd(), file)); }
  catch (error) { failed = true; process.stderr.write(`${error.message}\n`); }
}
if (failed) process.exit(1);
console.log(`EJS syntax check passed for ${files.length} view file(s).`);
