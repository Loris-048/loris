const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index_v6.1.html', 'utf8');

const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;

while ((match = scriptRegex.exec(html)) !== null) {
    count++;
    const code = match[1];
    try {
        new vm.Script(code);
    } catch (e) {
        console.error(`💥 Syntax Error in Script Block #${count}:`);
        console.error(e.message);
        console.error(e.stack);
        process.exit(1);
    }
}
console.log("All script blocks compiled 100% successfully!");
process.exit(0);
