import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// استخدام مسار محلي مضمون للتخزين
const uploadDir = path.join(process.cwd(), 'uploads');
const processedDir = path.join(process.cwd(), 'processed');

try {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
} catch (e) {
  console.error("Error creating directories:", e);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // تنظيف اسم الملف ليدعم العربية والإنجليزية بدون مشاكل
    const safeName = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safeName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// رفع الملف
app.post('/api/upload', (req, res) => {
  upload.single('audioFile')(req, res, (err) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم اختيار ملف.' });
    res.json({ success: true, message: 'تم الرفع بنجاح!', filename: req.file.filename });
  });
});

// جلب قائمة الملفات
app.get('/api/files', (req, res) => {
  try {
    if (!fs.existsSync(uploadDir)) {
      return res.json({ success: true, files: [] });
    }
    fs.readdir(uploadDir, (err, files) => {
      if (err) return res.status(500).json({ success: false, error: 'خطأ في قراءة المجلد.' });
      
      const fileList = files.map(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
          createdAt: stats.birthtime
        };
      }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      
      res.json({ success: true, files: fileList });
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// التفريغ الذكي
app.post('/api/transcribe', async (req, res) => {
  try {
    const { filename, language } = req.body;
    const filePath = path.join(uploadDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'الملف غير موجود.' });

    const uploadResult = await ai.files.upload({
      file: filePath,
      config: { mimeType: 'audio/mp3' }
    });

    const prompt = `قم بتفريغ هذا الملف الصوتي بدقة واحترافية عالية. اللهجة أو اللغة المطلوبة هي: ${language}.`;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
        { text: prompt },
      ]
    });

    res.json({ success: true, text: response.text });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// معالجة الصوت (قص أو تحويل)
app.post('/api/process-audio', (req, res) => {
  const { filename, action, startTime, duration, targetFormat } = req.body;
  const inputPath = path.join(uploadDir, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ success: false, error: 'الملف غير موجود.' });

  const outputFilename = `processed-${Date.now()}.${targetFormat || 'mp3'}`;
  const outputPath = path.join(processedDir, outputFilename);

  let command = ffmpeg(inputPath);

  if (action === 'trim') {
    command = command.setStartTime(startTime).setDuration(duration);
  }

  command
    .output(outputPath)
    .on('end', () => {
      res.json({ 
        success: true, 
        message: 'تمت المعالجة بنجاح!', 
        downloadUrl: `/api/download-processed/${outputFilename}` 
      });
    })
    .on('error', (err) => {
      res.status(500).json({ success: false, error: 'خطأ معالجة الصوت: ' + err.message });
    })
    .run();
});

// تحميل الملف المعالج
app.get('/api/download-processed/:filename', (req, res) => {
  const filePath = path.join(processedDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('الملف غير موجود');
  }
});

const server = app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
server.timeout = 3600000;
