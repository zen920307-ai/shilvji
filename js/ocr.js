/**
 * 本地 OCR：DeepSeek 等纯文本模型不能直接看图时使用
 * 依赖 tesseract.js
 */

let workerPromise = null;

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = await import('tesseract.js');
      // 英文为主（海外菜单）；+ 简体中文便于对照
      const worker = await Tesseract.createWorker('eng+chi_sim', 1, {
        logger: (m) => {
          if (m?.status === 'recognizing text' && typeof onProgress === 'function') {
            onProgress(m.progress || 0);
          }
        },
      });
      return worker;
    })();
  }
  return workerPromise;
}

/**
 * @param {File|Blob|string} image  File / Blob / dataURL
 * @param {(p: number) => void} [onProgress] 0~1
 */
export async function ocrImage(image, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(image);
  return (data?.text || '').trim();
}

/**
 * 多张菜单图 OCR 合并
 * @param {File[]} files
 * @param {(info: { index: number, total: number, progress: number }) => void} [onProgress]
 */
export async function ocrMenuFiles(files, onProgress) {
  const parts = [];
  const total = files.length;
  for (let i = 0; i < total; i++) {
    const text = await ocrImage(files[i], (p) => {
      if (typeof onProgress === 'function') {
        onProgress({ index: i + 1, total, progress: p });
      }
    });
    if (text) {
      parts.push(`--- 第 ${i + 1} 页菜单 OCR ---\n${text}`);
    }
  }
  const merged = parts.join('\n\n').trim();
  if (!merged) {
    throw new Error('本地读字失败，请换更清晰的菜单照片再试');
  }
  return merged;
}
