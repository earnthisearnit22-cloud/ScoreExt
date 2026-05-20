import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Video, Download, FileText, Loader, CheckCircle, AlertCircle, Play, Crop, RefreshCw, Folder, Clock, Settings, Layers, Trash } from 'lucide-react';

const API_BASE = window.location.port === '5173' ? 'http://localhost:8000' : window.location.origin;

function App() {
  const [url, setUrl] = useState('');
  const [songTitle, setSongTitle] = useState('');
  const [previewUrl, setPreviewUrl] = useState(null);
  const [roi, setRoi] = useState(null); // {x, y, w, h} in percentages
  const [taskId, setTaskId] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [outputPath, setOutputPath] = useState(() => localStorage.getItem('scoreext_output_path') || '');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [startTime, setStartTime] = useState('00:00:00');
  const [endTime, setEndTime] = useState('');
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [error, setError] = useState(null);

  // リサイズ・移動用ステート
  const [resizing, setResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState(null);
  const [resizeStartPos, setResizeStartPos] = useState({ x: 0, y: 0 });
  const [resizeStartRoi, setResizeStartRoi] = useState(null);

  // 履歴用ステート
  const [history, setHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('scoreext_history')) || [];
    } catch (_) {
      return [];
    }
  });
  const [pendingRoi, setPendingRoi] = useState(null);

  // ROI selection refs
  const previewRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState(null);

  useEffect(() => {
    let interval;
    if (taskId && status?.status !== 'completed' && status?.status !== 'error') {
      interval = setInterval(async () => {
        try {
          const response = await axios.get(`${API_BASE}/status/${taskId}`);
          setStatus(response.data);
          if (response.data.status === 'completed' || response.data.status === 'error') {
            clearInterval(interval);
            setLoading(false);
          }
        } catch (err) {
          console.error(err);
          clearInterval(interval);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [taskId, status]);

  useEffect(() => {
    localStorage.setItem('scoreext_output_path', outputPath);
  }, [outputPath]);

  // リサイズ・移動処理の useEffect
  useEffect(() => {
    if (!resizing || !resizeStartRoi) return;

    const handleMouseMove = (e) => {
      if (!previewRef.current) return;
      const rect = previewRef.current.getBoundingClientRect();
      const dx = (e.clientX - resizeStartPos.x) / rect.width;
      const dy = (e.clientY - resizeStartPos.y) / rect.height;

      let newRoi = { ...resizeStartRoi };

      if (resizeHandle === 'move') {
        newRoi.x = Math.max(0, Math.min(1 - newRoi.width, resizeStartRoi.x + dx));
        newRoi.y = Math.max(0, Math.min(1 - newRoi.height, resizeStartRoi.y + dy));
      } else {
        if (resizeHandle.includes('left')) {
          const newX = Math.max(0, Math.min(resizeStartRoi.x + resizeStartRoi.width - 0.05, resizeStartRoi.x + dx));
          newRoi.width = resizeStartRoi.x + resizeStartRoi.width - newX;
          newRoi.x = newX;
        }
        if (resizeHandle.includes('right')) {
          newRoi.width = Math.max(0.05, Math.min(1 - resizeStartRoi.x, resizeStartRoi.width + dx));
        }
        if (resizeHandle.includes('top')) {
          const newY = Math.max(0, Math.min(resizeStartRoi.y + resizeStartRoi.height - 0.05, resizeStartRoi.y + dy));
          newRoi.height = resizeStartRoi.y + resizeStartRoi.height - newY;
          newRoi.y = newY;
        }
        if (resizeHandle.includes('bottom')) {
          newRoi.height = Math.max(0.05, Math.min(1 - resizeStartRoi.y, resizeStartRoi.height + dy));
        }
      }

      newRoi.x = parseFloat(newRoi.x.toFixed(4));
      newRoi.y = parseFloat(newRoi.y.toFixed(4));
      newRoi.width = parseFloat(newRoi.width.toFixed(4));
      newRoi.height = parseFloat(newRoi.height.toFixed(4));

      setRoi(newRoi);
    };

    const handleMouseUp = () => {
      setResizing(false);
      setResizeHandle(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing, resizeHandle, resizeStartPos, resizeStartRoi]);

  // 変換成功時に自動で履歴へ追加する useEffect
  useEffect(() => {
    if (status?.status === 'completed' && taskId) {
      setHistory(prev => {
        // 重複判定
        const exists = prev.some(item => item.url === url && JSON.stringify(item.roi) === JSON.stringify(roi));
        if (exists) return prev;

        const newHistory = [
          {
            id: taskId,
            url,
            title: songTitle || 'Untitled Score',
            roi,
            startTime,
            endTime,
            rowsPerPage,
            timestamp: new Date().toLocaleString()
          },
          ...prev.slice(0, 4) // 最大5つまで保持
        ];
        localStorage.setItem('scoreext_history', JSON.stringify(newHistory));
        return newHistory;
      });
    }
  }, [status, taskId]);

  // プレビュー取得（自動検出対応）
  const fetchPreview = async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    setPreviewUrl(null);
    setRoi(null);
    try {
      const response = await axios.post(`${API_BASE}/preview`, { url });
      const { previewUrl: pUrl, detectedRoi } = response.data;
      setPreviewUrl(`${API_BASE}${pUrl}`);
      
      // 履歴から復元された pendingRoi があれば優先し、無ければ五線譜の自動検出を適用
      if (pendingRoi) {
        setRoi(pendingRoi);
        setPendingRoi(null);
      } else if (detectedRoi) {
        setRoi(detectedRoi);
      }
      setLoading(false);
    } catch (err) {
      setError('プレビューの取得に失敗しました。URLを確認してください。');
      setLoading(false);
    }
  };

  // 履歴プリセットを読み込んでプレビューをキックする関数
  const handleLoadHistory = (item) => {
    setUrl(item.url);
    setSongTitle(item.title);
    setStartTime(item.startTime || '00:00:00');
    setEndTime(item.endTime || '');
    setRowsPerPage(item.rowsPerPage || 10);
    setPendingRoi(item.roi);
    
    // 状態が反映されるのを待ってプレビュー自動取得
    setLoading(true);
    setError(null);
    setPreviewUrl(null);
    setRoi(null);
    axios.post(`${API_BASE}/preview`, { url: item.url })
      .then(res => {
        setPreviewUrl(`${API_BASE}${res.data.previewUrl}`);
        setRoi(item.roi);
        setLoading(false);
        setPendingRoi(null);
      })
      .catch(() => {
        setError('履歴からのプレビュー復元に失敗しました。');
        setLoading(false);
      });
  };

  const handleDeleteHistory = (e, itemId) => {
    e.stopPropagation();
    setHistory(prev => {
      const newHistory = prev.filter(item => item.id !== itemId);
      localStorage.setItem('scoreext_history', JSON.stringify(newHistory));
      return newHistory;
    });
  };

  const handleMouseDown = (e) => {
    const rect = previewRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPos({ x, y });
    setDragging(true);
    setCurrentRect({ x, y, w: 0, h: 0 });
  };

  const handleMouseMove = (e) => {
    if (!dragging) return;
    const rect = previewRef.current.getBoundingClientRect();
    const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    
    const x = Math.min(startPos.x, curX);
    const y = Math.min(startPos.y, curY);
    const w = Math.abs(curX - startPos.x);
    const h = Math.abs(curY - startPos.y);
    
    setCurrentRect({ x, y, w, h });
  };

  const handleMouseUp = () => {
    if (!dragging) return;
    setDragging(false);
    if (currentRect && currentRect.w > 10 && currentRect.h > 10) {
      const rect = previewRef.current.getBoundingClientRect();
      setRoi({
        x: currentRect.x / rect.width,
        y: currentRect.y / rect.height,
        width: currentRect.w / rect.width,
        height: currentRect.h / rect.height
      });
    } else {
      setRoi(null);
      setCurrentRect(null);
    }
  };

  const handleResizeStart = (e, handle) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(true);
    setResizeHandle(handle);
    setResizeStartPos({ x: e.clientX, y: e.clientY });
    setResizeStartRoi({ ...roi });
  };

  const handleBrowseFolder = async () => {
    setIsBrowsing(true);
    try {
      const response = await axios.post(`${API_BASE}/browse-folder`);
      if (response.data.path) {
        setOutputPath(response.data.path);
      }
    } catch (err) {
      console.error('Folder selection cancelled or failed');
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleStartConvert = async () => {
    if (!url || !roi) return;
    setLoading(true);
    setTaskId(null);
    setStatus(null);
    try {
      const response = await axios.post(`${API_BASE}/convert`, { 
        url, 
        crop: roi,
        title: songTitle || 'Untitled Score',
        outputPath: outputPath,
        startTime: startTime,
        endTime: endTime,
        rowsPerPage: rowsPerPage
      });
      setTaskId(response.data.task_id);
    } catch (err) {
      setError('変換の開始に失敗しました。');
      setLoading(false);
    }
  };

  const getStatusMessage = () => {
    if (!status) return '処理を開始します...';
    if (status.detail) return status.detail;
    switch (status.status) {
      case 'downloading': return `動画をダウンロード中... (${status.progress}%)`;
      case 'processing': return '指定範囲の楽譜をコマ送りで抽出中...';
      case 'generating_pdf': return 'A4 PDFを生成しています...';
      case 'completed': return '完了しました！';
      case 'error': return 'エラー: ' + status.message;
      default: return '処理中...';
    }
  };

  return (
    <div className="container">
      <div className="card">
        <h1>ScoreExt <span>楽譜抽出アシスタント</span></h1>
        <p className="subtitle">動画の範囲を選択して、そこだけを楽譜として抽出します</p>

        {!previewUrl && !taskId && (
          <div className="input-group">
            <div style={{ position: 'relative' }}>
              <Video style={{ position: 'absolute', left: '20px', top: '22px', color: 'var(--text-gray)' }} size={24} />
              <input 
                type="text" 
                placeholder="YouTube URLを貼り付けてプレビューを表示..." 
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
                style={{ paddingLeft: '56px' }}
              />
            </div>
            
            <div style={{ position: 'relative', marginTop: '16px' }}>
              <FileText style={{ position: 'absolute', left: '20px', top: '22px', color: 'var(--text-gray)' }} size={24} />
              <input 
                type="text" 
                placeholder="曲名を手動入力（PDFのヘッダーに表示されます）" 
                value={songTitle}
                onChange={(e) => setSongTitle(e.target.value)}
                disabled={loading}
                style={{ paddingLeft: '56px' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '16px', marginTop: '16px' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                 <Clock style={{ position: 'absolute', left: '20px', top: '22px', color: 'var(--text-gray)' }} size={24} />
                 <input 
                   type="text" 
                   placeholder="開始時間 (例 00:00:05)" 
                   value={startTime}
                   onChange={(e) => setStartTime(e.target.value)}
                   style={{ paddingLeft: '56px' }}
                 />
              </div>
              <div style={{ position: 'relative', flex: 1 }}>
                 <Clock style={{ position: 'absolute', left: '20px', top: '22px', color: 'var(--text-gray)' }} size={24} />
                 <input 
                   type="text" 
                   placeholder="終了時間 (空欄で最後まで)" 
                   value={endTime}
                   onChange={(e) => setEndTime(e.target.value)}
                   style={{ paddingLeft: '56px' }}
                 />
              </div>
              <div style={{ position: 'relative', width: '150px' }}>
                 <Layers style={{ position: 'absolute', left: '20px', top: '22px', color: 'var(--text-gray)' }} size={24} />
                 <input 
                   type="number" 
                   value={rowsPerPage}
                   onChange={(e) => setRowsPerPage(e.target.value)}
                   style={{ paddingLeft: '56px' }}
                   min="1"
                   max="20"
                 />
                 <span style={{ position: 'absolute', right: '15px', top: '22px', color: 'var(--text-gray)', fontSize: '0.8rem' }}>段/頁</span>
              </div>
            </div>

            <div style={{ position: 'relative', marginTop: '16px', display: 'flex', gap: '12px', alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Folder style={{ position: 'absolute', left: '20px', top: '22px', color: 'var(--text-gray)' }} size={24} />
                <input 
                  type="text" 
                  placeholder="保存先フォルダ（空欄でダウンロードのみ）" 
                  value={outputPath}
                  onChange={(e) => setOutputPath(e.target.value)}
                  disabled={loading || isBrowsing}
                  style={{ paddingLeft: '56px' }}
                />
              </div>
              <button 
                className="btn secondary" 
                style={{ width: 'auto', padding: '0 20px', height: '60px' }}
                onClick={handleBrowseFolder}
                disabled={loading || isBrowsing}
              >
                {isBrowsing ? <Loader className="pulse" size={20} /> : '参照...'}
              </button>
            </div>

            <button 
              className="btn" 
              style={{ marginTop: '24px' }} 
              onClick={fetchPreview}
              disabled={loading || !url}
            >
              {loading ? <Loader className="pulse" /> : <Play size={20} />}
              プレビューを表示
            </button>
          </div>
        )}

        {history.length > 0 && !previewUrl && !taskId && (
          <div className="history-section">
            <h2 className="history-title">
              <Clock size={20} /> 最近の変換履歴（プリセット）
            </h2>
            <div className="history-grid">
              {history.map((item) => (
                <div 
                  key={item.id} 
                  className="history-card" 
                  onClick={() => handleLoadHistory(item)}
                >
                  <div className="history-card-header">
                    <span className="history-card-title">{item.title}</span>
                    <button 
                      className="delete-btn" 
                      onClick={(e) => handleDeleteHistory(e, item.id)}
                      title="履歴から削除"
                    >
                      <Trash size={16} />
                    </button>
                  </div>
                  <div className="history-card-body">
                    <p className="history-meta"><strong>開始/終了:</strong> {item.startTime || '00:00:00'} ~ {item.endTime || '最後まで'}</p>
                    <p className="history-meta"><strong>レイアウト:</strong> {item.rowsPerPage} 段/頁</p>
                    <p className="history-meta-url" title={item.url}>{item.url}</p>
                  </div>
                  <div className="history-card-footer">
                    <span className="history-date">{item.timestamp}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {previewUrl && !taskId && (
          <div className="roi-section">
            <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
               <FileText size={20} color="var(--text-gray)" />
               <input 
                 type="text" 
                 placeholder="曲名を入力..." 
                 value={songTitle}
                 onChange={(e) => setSongTitle(e.target.value)}
                 style={{ 
                   background: 'rgba(255,255,255,0.05)', 
                   border: '1px solid var(--glass-border)',
                   padding: '8px 12px',
                   borderRadius: '8px',
                   flex: 1
                 }}
               />
            </div>
            <div 
              className="preview-container"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              ref={previewRef}
            >
              <img src={previewUrl} className="preview-img" alt="Video Preview" draggable={false} />
              {currentRect && (
                <div 
                  className="selection-rect" 
                  style={{ 
                    left: currentRect.x, 
                    top: currentRect.y, 
                    width: currentRect.w, 
                    height: currentRect.h 
                  }} 
                />
              )}
              {roi && !currentRect && (
                <div 
                  className="selection-rect active" 
                  style={{ 
                    left: `${roi.x * 100}%`, 
                    top: `${roi.y * 100}%`, 
                    width: `${roi.width * 100}%`, 
                    height: `${roi.height * 100}%`,
                    pointerEvents: 'auto'
                  }}
                >
                  <div 
                    className="drag-handle-center" 
                    onMouseDown={(e) => handleResizeStart(e, 'move')}
                  />
                  <div className="resize-handle top-left" onMouseDown={(e) => handleResizeStart(e, 'top-left')} />
                  <div className="resize-handle top-right" onMouseDown={(e) => handleResizeStart(e, 'top-right')} />
                  <div className="resize-handle bottom-left" onMouseDown={(e) => handleResizeStart(e, 'bottom-left')} />
                  <div className="resize-handle bottom-right" onMouseDown={(e) => handleResizeStart(e, 'bottom-right')} />
                  <div className="resize-handle top" onMouseDown={(e) => handleResizeStart(e, 'top')} />
                  <div className="resize-handle bottom" onMouseDown={(e) => handleResizeStart(e, 'bottom')} />
                  <div className="resize-handle left" onMouseDown={(e) => handleResizeStart(e, 'left')} />
                  <div className="resize-handle right" onMouseDown={(e) => handleResizeStart(e, 'right')} />
                </div>
              )}
              {!roi && !currentRect && <div className="selection-hint">楽譜の範囲をマウスで囲んでください（リサイズ・微調整可能）</div>}
            </div>

            <div className="roi-actions">
              <button className="btn" onClick={() => { setPreviewUrl(null); setRoi(null); setCurrentRect(null); }}>
                やり直す
              </button>
              <button className="btn" disabled={!roi || loading} onClick={handleStartConvert}>
                <Crop size={20} />
                この範囲で生成開始
              </button>
            </div>
          </div>
        )}

        {error && <div className="error-msg"><AlertCircle size={18} /> {error}</div>}

        {status && (
          <div className="status-card">
            {status.status === 'completed' ? (
              <div className="download-section" style={{ textAlign: 'center' }}>
                <div className="success-badge"><CheckCircle size={18} /> セレクト完了</div>
                <h3>指定された範囲の譜面が完成しました</h3>
                <button className="btn" style={{ marginTop: '20px', background: '#22c55e' }} onClick={() => window.open(`${API_BASE}/download/${taskId}`)}>
                  <Download size={20} /> PDFをダウンロード
                </button>
                <button className="btn" style={{ marginTop: '12px', background: 'transparent', border: '1px solid var(--glass-border)' }} onClick={() => { setTaskId(null); setStatus(null); }}>
                  別の範囲・動画で作成
                </button>
              </div>
            ) : status.status === 'error' ? (
              <div className="error-msg">{status.message}</div>
            ) : (
              <>
                <div className="status-text">
                  <span>{getStatusMessage()}</span>
                  <span>{status.progress}%</span>
                </div>
                <div className="progress-container">
                  <div className="progress-bar" style={{ width: `${status.progress}%` }}></div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <footer style={{ marginTop: '48px', textAlign: 'center', color: 'var(--text-gray)', fontSize: '0.9rem' }}>
        <p>© 2026 ScoreExt 楽譜自動抽出ツール. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default App;
