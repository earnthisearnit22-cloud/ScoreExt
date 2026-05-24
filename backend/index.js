const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
sharp.cache(false); // 複数フレームの連続処理時のメモリリークとクラッシュを防止

process.on('uncaughtException', (err) => {
    fs.writeFileSync('crash.log', 'Uncaught Exception: ' + err.stack + '\n', { flag: 'a' });
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    fs.writeFileSync('crash.log', 'Unhandled Rejection at: ' + promise + ' reason: ' + reason + '\n', { flag: 'a' });
    process.exit(1);
});

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * プレビュー画像から五線譜の水平線を検出し、楽譜が描かれている主要なROI（縦方向の範囲）を自動検出する
 */
async function detectSheetMusicRoi(imagePath) {
    try {
        const img = sharp(imagePath);
        const metadata = await img.metadata();
        const width = metadata.width;
        const height = metadata.height;
        
        // rawピクセルデータをグレースケールで取得
        const { data, info } = await img
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });
            
        const rowBlackRatios = [];
        const ignoreTop = Math.floor(height * 0.08);    // 上部8%は動画タイトル等のノイズ防止で除外
        const ignoreBottom = Math.floor(height * 0.12); // 下部12%はシークバー等のノイズ防止で除外
        
        for (let y = 0; y < height; y++) {
            if (y < ignoreTop || y > height - ignoreBottom) {
                rowBlackRatios.push(0);
                continue;
            }
            
            let blackCount = 0;
            const rowOffset = y * width;
            for (let x = 0; x < width; x++) {
                if (data[rowOffset + x] < 120) { // 輝度が120未満（暗い線）を検知
                    blackCount++;
                }
            }
            rowBlackRatios.push(blackCount / width);
        }
        
        // 五線譜の長い横線が存在する行は、黒ピクセル比率が一定以上高くなる
        const lineYCoordinates = [];
        for (let y = 0; y < height; y++) {
            if (rowBlackRatios[y] > 0.18) { // 18%以上の暗いピクセルがある行を水平線候補とする
                lineYCoordinates.push(y);
            }
        }
        
        if (lineYCoordinates.length > 0) {
            const yMin = Math.min(...lineYCoordinates);
            const yMax = Math.max(...lineYCoordinates);
            
            // 五線譜の上下の飛び出し音符や記号をカバーするため、安全マージンとして20pxを確保
            const safeTop = Math.max(0, yMin - 20);
            const safeBottom = Math.min(height, yMax + 20);
            
            return {
                x: 0,
                y: parseFloat((safeTop / height).toFixed(4)),
                width: 1.0,
                height: parseFloat(((safeBottom - safeTop) / height).toFixed(4))
            };
        }
    } catch (e) {
        console.warn('Sheet music detection failed:', e.message);
    }
    
    // 検出に失敗した、または水平線が見つからなかった場合の安全な初期値（中央の60%）
    return { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };
}

const app = express();
app.use(cors());
app.use(express.json());

const tasks = {};

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

/**
 * プレビュー画像（30秒時点）を取得
 */
async function getPreviewFrame(url, previewPath) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
        const ls = spawn(ytDlpPath, [
            url,
            '-g',
            '--format', 'bestvideo[ext=mp4]/best[ext=mp4]',
            '--js-runtimes', `node:${process.execPath}`
        ]);

        let videoUrl = '';
        ls.stdout.on('data', (data) => videoUrl += data.toString().trim());

        ls.on('close', (code) => {
            if (code !== 0 || !videoUrl) return reject(new Error('Failed to get video stream URL'));

            ffmpeg(videoUrl)
                .seekInput('00:00:30')
                .frames(1)
                .size('1280x720')
                .output(previewPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });
    });
}

function downloadVideo(url, outputPath, taskId) {
    return new Promise((resolve, reject) => {
        const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
        const ls = spawn(ytDlpPath, [
            url,
            '-o', outputPath,
            '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--ffmpeg-location', path.dirname(ffmpegPath),
            '--no-playlist',
            '--js-runtimes', `node:${process.execPath}`
        ]);

        ls.stdout.on('data', (data) => {
            const match = data.toString().match(/(\d+\.\d+)%/);
            if (match) {
                const percent = Math.floor(parseFloat(match[1]));
                tasks[taskId].progress = Math.floor(percent * 0.2);
                tasks[taskId].detail = `YouTubeから動画をダウンロード中... (${percent}%)`;
            }
        });

        ls.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`yt-dlp exited with code ${code}`));
        });
    });
}

async function processVideo(videoUrl, taskId, crop, title, outputPath, options = {}) {
    const { startTime = '00:00:00', endTime = null, rowsPerPage = 10 } = options;
    try {
        tasks[taskId] = { status: 'downloading', progress: 0, title: title, detail: 'YouTube動画のダウンロードを開始します...' };
        const taskDir = path.join(TEMP_DIR, taskId);
        if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir);
        const videoPath = path.join(taskDir, 'video.mp4');
        
        await downloadVideo(videoUrl, videoPath, taskId);

        tasks[taskId].status = 'processing';
        tasks[taskId].progress = 20;
        tasks[taskId].detail = '動画からフレーム画像を切り出しています... (2.0 fps)';

        const framesDir = path.join(taskDir, 'frames');
        const processedDir = path.join(taskDir, 'processed');
        if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);
        if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);

        await new Promise((resolve, reject) => {
            const ff = ffmpeg(videoPath);
            if (startTime) ff.seekInput(startTime);
            if (endTime) ff.duration(endTime); // duration is T-S if duration(T), but in fluent-ffmpeg duration() is length. Better to use -to.
            
            ff.fps(2)
                .size('1280x720')
                .outputOptions(['-q:v 2'])
                .output(path.join(framesDir, 'frame-%04d.jpg'))
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        const frameFiles = fs.readdirSync(framesDir).sort();
        const capturedImages = [];
        let lastBuffer = null;        // 1つ前のフレーム（瞬間的な動きの検知用）
        let lastSavedBuffer = null;   // 最後にPDF保存を「確定」したフレーム（譜面の切り替わり検知用）

        for (const [idx, file] of frameFiles.entries()) {
            const filePath = path.join(framesDir, file);
            const processedPath = path.join(processedDir, `processed_${file}`);
            
            const sharpImg = sharp(filePath);
            const metadata = await sharpImg.metadata();

            try {
                const rawLeft = Math.floor(crop.x * metadata.width);
                const rawTop = Math.floor(crop.y * metadata.height);
                const left = Math.max(0, rawLeft);
                const top = Math.max(0, rawTop);
                
                // 元の幅・高さから、クリップされた座標分を差し引く（右下の座標が変わらないようにする）
                const rawWidth = Math.floor(crop.width * metadata.width) - (left - rawLeft);
                const rawHeight = Math.floor(crop.height * metadata.height) - (top - rawTop);

                const extractData = {
                    left: left,
                    top: top,
                    width: Math.max(1, Math.min(rawWidth, metadata.width - left)),
                    height: Math.max(1, Math.min(rawHeight, metadata.height - top))
                };
                
                await sharpImg
                    .extract(extractData)
                    .grayscale()
                    .normalize()
                    .sharpen({ sigma: 1.0, m1: 0.2, m2: 2.0 })
                    .modulate({ brightness: 1.0, contrast: 1.2 })
                    .jpeg({ quality: 85 })
                    .toFile(processedPath);

                const currentBuffer = await sharp(processedPath)
                    .resize(50, 50, { fit: 'fill' })
                    .grayscale()
                    .raw()
                    .toBuffer();
                
                if (!lastSavedBuffer) {
                    // 最初のフレームは無条件で保存確定
                    capturedImages.push(processedPath);
                    lastSavedBuffer = currentBuffer;
                } else {
                    // ピクセルごとの差分を純粋なJSで計算（Sharpのcompositeによるメモリリークやクラッシュを完全に防ぐ）
                    let stepDiffSum = 0;
                    let accDiffSum = 0;
                    for (let i = 0; i < currentBuffer.length; i++) {
                        stepDiffSum += Math.abs(currentBuffer[i] - lastBuffer[i]);
                        accDiffSum += Math.abs(currentBuffer[i] - lastSavedBuffer[i]);
                    }
                    const stepMean = stepDiffSum / currentBuffer.length;
                    const accMean = accDiffSum / currentBuffer.length;

                    // 判定基準: 
                    // ・直前フレームからの動きが小さい（＝静止・安定している、閾値 4.5）
                    // ・かつ、最後に確定した譜面から十分に変化している（＝新しい譜面になっている、閾値 5.5）
                    if (stepMean < 4.5 && accMean >= 5.5) {
                        capturedImages.push(processedPath);
                        lastSavedBuffer = currentBuffer;
                    } else {
                        // 条件を満たさない（スクロール過渡期、または変化なし）場合はPDF用画像としてはスキップ
                        fs.unlinkSync(processedPath);
                    }
                }

                // 瞬間的な動きを検知するため、lastBuffer は毎フレーム更新する
                lastBuffer = currentBuffer;
            } catch (e) {
                console.warn('Crop skipped', e.message);
                if (fs.existsSync(processedPath)) {
                    try { fs.unlinkSync(processedPath); } catch(_) {}
                }
            }
            
            tasks[taskId].progress = 20 + Math.floor((idx / frameFiles.length) * 60);
            tasks[taskId].detail = `譜面の重複判定と動きの解析中... (解析済: ${idx + 1} / ${frameFiles.length} フレーム)`;

            // 定期的にイベントループを解放してメモリ解放(GC)とステータスAPIの応答を促す
            if (idx % 10 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (capturedImages.length === 0) throw new Error('No frames captured.');

        tasks[taskId].status = 'generating_pdf';
        tasks[taskId].progress = 80;
        tasks[taskId].detail = `A4 PDF楽譜を最適レイアウトで構築中... (検出譜面数: ${capturedImages.length} 枚)`;

        const pdfPath = path.join(taskDir, 'sheet_music.pdf');
        const doc = new PDFDocument({ size: 'A4', margin: 20 });
        const pdfStream = fs.createWriteStream(pdfPath);
        doc.pipe(pdfStream);

        // Generate title as an image buffer using SVG to avoid font embedding issues
        let titleBuffer = null;
        try {
            const escapedTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const svgText = `<svg width="800" height="60"><text x="400" y="45" font-family="sans-serif" font-size="32" text-anchor="middle" fill="black">${escapedTitle}</text></svg>`;
            titleBuffer = await sharp(Buffer.from(svgText)).png().toBuffer();
        } catch (e) {
            console.warn('Title generation failed', e.message);
        }

        const itemsPerPage = parseInt(rowsPerPage) || 10;
        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const margin = 30;
        const contentWidth = pageWidth - (margin * 2);
        
        // Generate QR Code
        let qrBuffer = null;
        try {
            qrBuffer = await QRCode.toBuffer(videoUrl, { margin: 1, width: 100 });
        } catch (e) {
            console.warn('QR generation failed', e.message);
        }
        
        let currentPageRowStartOffset = margin;
        
        // 1ページ目のヘッダー高さをあらかじめ確定させる（タイトルやQRコードの表示エリアを確保）
        let firstPageRowStartOffset = margin;
        if (titleBuffer || title) {
            firstPageRowStartOffset = margin + 45; // タイトル表示用に45px分下にずらす
        }

        for (const [idx, imgPath] of capturedImages.entries()) {
            const slotIndex = idx % itemsPerPage;
            
            if (idx % itemsPerPage === 0) {
                if (idx !== 0) {
                    doc.addPage();
                }
                
                if (idx === 0) {
                    currentPageRowStartOffset = firstPageRowStartOffset;
                    
                    // 1ページ目のヘッダー（タイトルやQRコード）を描画
                    if (qrBuffer) {
                        doc.image(qrBuffer, pageWidth - margin - 40, margin, { width: 40 });
                    }
                    if (titleBuffer) {
                        doc.image(titleBuffer, margin, margin, { width: contentWidth - 50, align: 'center' });
                    } else {
                        doc.fontSize(18).text(title, margin, margin, { align: 'center', width: contentWidth - 50 });
                    }
                } else {
                    currentPageRowStartOffset = margin;
                }
            }
            
            const availableHeight = pageHeight - currentPageRowStartOffset - margin;
            const itemHeight = availableHeight / itemsPerPage;
            const yPos = currentPageRowStartOffset + (slotIndex * itemHeight);
            
            doc.image(imgPath, margin, yPos, { 
                fit: [contentWidth, itemHeight - 10],
                align: 'center',
                valign: 'center'
            });
        }
        doc.end();

        await new Promise((resolve, reject) => {
            pdfStream.on('finish', resolve);
            pdfStream.on('error', reject);
        });
        
        if (outputPath && fs.existsSync(outputPath)) {
            try {
                const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_') + '.pdf';
                const finalPath = path.join(outputPath, safeTitle);
                fs.copyFileSync(pdfPath, finalPath);
                console.log(`Saved to custom directory: ${finalPath}`);
            } catch (e) {
                console.warn('Failed to copy to custom directory', e.message);
            }
        }

        tasks[taskId] = { status: 'completed', progress: 100, pdfUrl: `/download/${taskId}`, title: title, detail: '楽譜の生成が正常に完了しました！' };

    } catch (error) {
        console.error(error);
        tasks[taskId] = { status: 'error', message: error.message };
    }
}

app.post('/preview', async (req, res) => {
    const { url } = req.body;
    const previewId = uuidv4();
    const previewPath = path.join(TEMP_DIR, `preview_${previewId}.jpg`);
    try {
        await getPreviewFrame(url, previewPath);
        
        // 楽譜領域の自動検出を実行
        const detectedRoi = await detectSheetMusicRoi(previewPath);
        
        res.json({
            previewId: previewId,
            previewUrl: `/preview-image/${previewId}`,
            detectedRoi: detectedRoi
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/preview-image/:previewId', (req, res) => {
    const previewPath = path.join(TEMP_DIR, `preview_${req.params.previewId}.jpg`);
    if (fs.existsSync(previewPath)) {
        res.sendFile(previewPath);
    } else {
        res.status(404).send('Preview not found');
    }
});

app.post('/convert', (req, res) => {
    const { url, crop, title, outputPath, startTime, endTime, rowsPerPage } = req.body;
    const taskId = uuidv4();
    processVideo(url, taskId, crop, title, outputPath, { startTime, endTime, rowsPerPage })
        .catch(err => {
            console.error('Unhandled error in processVideo:', err);
            if (tasks[taskId]) {
                tasks[taskId].status = 'error';
                tasks[taskId].message = '予期せぬエラーが発生しました: ' + err.message;
            }
        });
    res.json({ task_id: taskId });
});

app.get('/status/:taskId', (req, res) => {
    const task = tasks[req.params.taskId];
    if (!task) return res.status(404).send('Task not found');
    res.json(task);
});

app.get('/download/:taskId', (req, res) => {
    const task = tasks[req.params.taskId];
    const pdfPath = path.join(TEMP_DIR, req.params.taskId, 'sheet_music.pdf');
    if (fs.existsSync(pdfPath)) {
        const title = task?.title || 'sheet_music';
        // Remove invalid filename characters
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_') + '.pdf';
        res.download(pdfPath, safeTitle);
    } else {
        res.status(404).send('File not found');
    }
});

app.post('/browse-folder', (req, res) => {
    const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.FolderBrowserDialog
    $f.Description = "保存先のフォルダを選択してください"
    $f.ShowNewFolderButton = $true
    if($f.ShowDialog() -eq 'OK'){ $f.SelectedPath }
    `;
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', script]);
    let output = '';
    ps.stdout.on('data', (data) => output += data.toString());
    ps.on('close', (code) => {
        const selectedPath = output.trim();
        if (code === 0 && selectedPath) {
            res.json({ path: selectedPath });
        } else {
            res.status(400).json({ error: 'Folder selection cancelled' });
        }
    });
});

// Serve static assets from the frontend build directory
const frontendDistPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/download') || req.path.startsWith('/status') || req.path.startsWith('/preview') || req.path.startsWith('/preview-image') || req.path.startsWith('/convert') || req.path.startsWith('/browse-folder')) {
            return next();
        }
        res.sendFile(path.join(frontendDistPath, 'index.html'));
    });
}

const PORT = 8000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on port ${PORT}`);
});
