// cdp-loris-full.js - Set params + optional upload ref image + generate + collect console logs + download result
// Model: uses fuzzy match to find best match in dropdown, then clicks the option
// Usage: node cdp-loris-full.js "<prompt>" "<model>" "<ratio>" "<size>" ["<refImagePath>"]
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
let m = 1;
function cdpSend(ws, method, params = {}) {
    return new Promise((ok, no) => {
        const id = m++;
        const t = setTimeout(() => { ws.off('message', h); no(new Error('timeout')); }, 20000);
        const h = d => { const j = JSON.parse(d.toString()); if (j.id === id) { clearTimeout(t); ws.off('message', h); j.error ? no(new Error(JSON.stringify(j.error))) : ok(j.result); } };
        ws.on('message', h);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function getPageWs() {
    const wsUrl = await new Promise((ok, no) => {
        require('http').get('http://localhost:9222/json', r => {
            let b = ''; r.on('data', c => b += c);
            r.on('end', () => {
                const pages = JSON.parse(b);
                const p = pages.find(p => p.type === 'page' && p.url.includes('index_v16'));
                if (p) ok(p.webSocketDebuggerUrl);
                else no(new Error('Loris page not found'));
            });
        }).on('error', no);
    });
    const ws = new WebSocket(wsUrl);
    await new Promise(r => ws.on('open', r));
    return ws;
}

function downloadFile(url, outPath) {
    return new Promise((ok, no) => {
        const file = fs.createWriteStream(outPath);
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                fs.unlinkSync(outPath);
                downloadFile(res.headers.location, outPath).then(ok).catch(no);
                return;
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); ok(outPath); });
        }).on('error', e => { fs.unlinkSync(outPath); no(e); });
    });
}

(async () => {
    const prompt = process.argv[2] || '一只可爱的猫咪';
    const model = process.argv[3] || '';
    const ratio = process.argv[4] || '';
    const size = process.argv[5] || '';
    const refImages = process.argv.slice(6).filter(Boolean); // 0~N reference image paths

    const ws = await getPageWs();
    console.log('[1] connected');

    // Enable console log collection & DOM
    await cdpSend(ws, 'Runtime.enable', {});
    await cdpSend(ws, 'DOM.enable', {});
    const logs = [];
    ws.on('message', d => {
        const msg = JSON.parse(d.toString());
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = msg.params.args.map(a => a.value || a.description || '').join(' ');
            logs.push(args);
        }
    });

    // 1. Set prompt FIRST (before anything else)
    const r1 = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            var el = document.getElementById('prompt');
            if (!el) return 'no_prompt';
            var s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
            if (s) { s.call(el, ${JSON.stringify(prompt)}); } else { el.value = ${JSON.stringify(prompt)}; }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return 'prompt_set:' + el.value;
        })()`,
        returnByValue: true
    });
    console.log('[2] ' + r1.result.value);
    await new Promise(r => setTimeout(r, 300));

    // 2. Set model - fuzzy match from dropdown
    if (model) {
        const r2 = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var wanted = ${JSON.stringify(model.toLowerCase())};
                var current = document.getElementById('modelSelect').value.trim();
                if (current.toLowerCase().includes(wanted) || wanted.includes(current.toLowerCase())) {
                    return 'model_already_set:' + current;
                }
                document.querySelector('.model-input-btn').click();
                return new Promise(function(resolve) {
                    setTimeout(function() {
                        var items = document.querySelectorAll('.model-dropdown-item');
                        var bestMatch = null;
                        var bestScore = 0;
                        for (var i = 0; i < items.length; i++) {
                            var text = items[i].textContent.trim().toLowerCase();
                            var score = 0;
                            if (text === wanted) { score = 100; }
                            else if (text.includes(wanted)) { score = 80; }
                            else if (wanted.includes(text)) { score = 70; }
                            else {
                                var wWords = wanted.replace(/[-_.]/g, ' ').split(' ');
                                var iWords = text.replace(/[-_.]/g, ' ').split(' ');
                                for (var w of wWords) {
                                    for (var iw of iWords) {
                                        if (w.length > 1 && iw.length > 1 && (iw.includes(w) || w.includes(iw))) { score += 20; }
                                    }
                                }
                            }
                            if (score > bestScore) { bestScore = score; bestMatch = items[i]; }
                        }
                        if (bestMatch && bestScore >= 20) {
                            var matchText = bestMatch.textContent.trim();
                            bestMatch.click();
                            setTimeout(function() {
                                var final = document.getElementById('modelSelect').value.trim();
                                resolve('model_selected:' + matchText + ' (input=' + final + ', score=' + bestScore + ')');
                            }, 300);
                        } else {
                            document.querySelector('.model-input-btn').click();
                            resolve('model_not_found: wanted=' + wanted + ', available=' + Array.from(items).map(i => i.textContent.trim()).join(', '));
                        }
                    }, 500);
                });
            })()`,
            returnByValue: true,
            awaitPromise: true
        });
        console.log('[3] ' + r2.result.value);
        await new Promise(r => setTimeout(r, 300));
    }

    // 3. Set ratio
    if (ratio) {
        const r3 = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.getElementById('aspectRatio');
                if (!el) return 'no_aspectRatio';
                el.value = ${JSON.stringify(ratio)};
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'ratio_set:' + el.value;
            })()`,
            returnByValue: true
        });
        console.log('[4] ' + r3.result.value);
        await new Promise(r => setTimeout(r, 300));
    }

    // 4. Set size
    if (size) {
        const r4 = await cdpSend(ws, 'Runtime.evaluate', {
            expression: `(function() {
                var el = document.getElementById('imageSizeSelect');
                if (!el) return 'no_imageSizeSelect';
                el.value = ${JSON.stringify(size)};
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'size_set:' + el.value;
            })()`,
            returnByValue: true
        });
        console.log('[5] ' + r4.result.value);
        await new Promise(r => setTimeout(r, 300));
    }

    // 5. Clear existing thumb-item preview thumbnails in upload area (ALWAYS, before any upload)
    console.log('[5a] clearing existing thumb previews...');
    try {
        for (let round = 0; round < 10; round++) {
            const clearResult = await cdpSend(ws, 'Runtime.evaluate', {
                expression: `(function() {
                    var btns = document.querySelectorAll('.thumb-item .thumb-remove');
                    var count = btns.length;
                    for (var i = 0; i < btns.length; i++) { btns[i].click(); }
                    return count;
                })()`,
                returnByValue: true
            });
            const cleared = clearResult.result.value;
            console.log('[5a] round ' + (round + 1) + ': clicked ' + cleared + ' buttons');
            if (cleared === 0) break;
            await new Promise(r => setTimeout(r, 800));
        }
    } catch(e) {
        console.log('[5a] clear warning: ' + e.message);
    }

    // 6. Upload reference images if provided
    if (refImages.length > 0) {
        // 6.1 Upload each reference image
        for (let i = 0; i < refImages.length; i++) {
            const absPath = path.resolve(refImages[i]);
            if (!fs.existsSync(absPath)) {
                console.log('[5a] ref image not found: ' + absPath);
                continue;
            }
            console.log('[5a] uploading ref image ' + (i + 1) + '/' + refImages.length + ': ' + absPath);
            try {
                await cdpSend(ws, 'DOM.enable', {});
                const objResult = await cdpSend(ws, 'Runtime.evaluate', {
                    expression: `document.getElementById('fileInput')`,
                });
                const domNode = await cdpSend(ws, 'DOM.describeNode', {
                    objectId: objResult.result.objectId
                });
                const backendNodeId = domNode.node.backendNodeId;
                await cdpSend(ws, 'DOM.setFileInputFiles', {
                    backendNodeId: backendNodeId,
                    files: [absPath]
                });
                console.log('[5a] uploaded image ' + (i + 1) + ' (backendNodeId=' + backendNodeId + ')');

                // Fire change event so handleFileSelect runs
                await cdpSend(ws, 'Runtime.evaluate', {
                    expression: `(function(){
                        var el = document.getElementById('fileInput');
                        if(el){ el.dispatchEvent(new Event('change',{bubbles:true})); return 'change_fired'; }
                        return 'no_input';
                    })()`,
                    returnByValue: true
                });
                await new Promise(r => setTimeout(r, 1500));
            } catch(e) {
                console.log('[5a] upload error on image ' + (i + 1) + ': ' + e.message);
            }
        }
        console.log('[5a] all ' + refImages.length + ' image(s) processed');
    }

    // 7. Click generate
    const r5 = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `(function() {
            var btn = document.getElementById('generateBtn');
            if (!btn) return 'no_generateBtn';
            btn.click();
            return 'clicked';
        })()`,
        returnByValue: true
    });
    console.log('[7] generate:' + r5.result.value);

    // 8. Wait and collect console logs
    console.log('[7] waiting for result (max 300s)...');
    const maxWait = 300000;
    const pollInterval = 3000;
    let imageUrl = null;
    let failed = false;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);

        // Check for real failure
        const recent = logs.slice(-20);
        for (const log of recent) {
            if (log.includes('审核') || log.includes('moderation') ||
                log.includes('"model not found"') ||
                (log.includes('status') && log.includes('"failed"'))) {
                console.log('[' + elapsed + 's] STATUS: FAILED');
                console.log('  -> ' + log.substring(0, 300));
                failed = true;
                break;
            }
        }
        if (failed) break;

        // Check for succeeded
        const hasSucceeded = logs.some(l => l.includes('"status":"succeeded"') || l.includes('"status": "succeeded"'));
        if (hasSucceeded) {
            for (const log of logs) {
                const m1 = log.match(/https?:\/\/file[0-9]*\.aitohumanize\.com\/[^\s"'\\]+/);
                if (m1) { imageUrl = m1[0]; break; }
            }
            if (!imageUrl) {
                for (const log of logs) {
                    const m2 = log.match(/https?:\/\/[^"\s]+\.(png|jpg|jpeg|webp)/i);
                    if (m2) { imageUrl = m2[0]; break; }
                }
            }
            if (!imageUrl) {
                for (const log of logs) {
                    const m3 = log.match(/"url"\s*:\s*"(https?:\/\/[^"]+)"/);
                    if (m3) { imageUrl = m3[1]; break; }
                }
            }
            console.log('[' + elapsed + 's] STATUS: SUCCEEDED');
            if (imageUrl) console.log('  URL: ' + imageUrl);
            else console.log('  (succeeded but no image URL extracted)');
            break;
        }

        const submitCount = logs.filter(l => l.includes('任务已提交')).length;
        const pollCount = logs.filter(l => l.includes('轮询第')).length;
        if (elapsed % 6 < 4) {
            console.log('[' + elapsed + 's] submitted:' + submitCount + ' polls:' + pollCount);
        }
    }

    // 9. Print important logs
    console.log('\n--- Console Logs ---');
    const important = logs.filter(l =>
        l.includes('提交') || l.includes('响应JSON') || l.includes('失败') || l.includes('成功') ||
        l.includes('任务已提交') || l.includes('完成') || l.includes('审核') ||
        l.includes('error') || l.includes('轮询响应JSON') || l.includes('succeeded') ||
        l.includes('failed') || l.includes('result') || l.includes('"url"')
    );
    important.forEach(l => console.log('  ' + l.substring(0, 300)));

    // 10. Download if URL found
    if (imageUrl) {
        const outPath = 'C:\\Users\\My Pc\\WorkBuddy\\Claw\\loris_latest.png';
        console.log('\n[8] downloading...');
        try {
            await downloadFile(imageUrl, outPath);
            const stat = fs.statSync(outPath);
            console.log('SAVED: ' + outPath + ' (' + (stat.size / 1024).toFixed(0) + ' KB)');
        } catch (e) {
            console.log('download error: ' + e.message);
        }
    } else if (!failed) {
        console.log('\n[8] no image URL found in logs after timeout');
    }

    ws.close();
    console.log('DONE');
})().catch(e => console.error(e.message));
