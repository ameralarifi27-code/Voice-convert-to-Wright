import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات السماح للواجهة بالاتصال
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// إعداد التخزين مع فحص الملفات المكررة
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // تنظيف اسم الملف
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_\u0600-\u06FF]/g, '_');
    const filePath = path.join(uploadDir, safeName);
    
    if (fs.existsSync(filePath)) {
      return cb(new Error('FILE_ALREADY_EXISTS'), '');
    }
    cb(null, safeName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // رفع الحد إلى 2 جيجا
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// 1. مسار رفع الملفات
app.post('/api/upload', (req, res) => {
  upload.single('audioFile')(req, res, (err) => {
    if (err) {
      if (err.message === 'FILE_ALREADY_EXISTS') {
        return res.status(400).json({ success: false, error: 'هذا الملف موجود مسبقاً! الرجاء تغيير اسمه أو اختيار ملف آخر.' });
      }
      return res.status(500).json({ success: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'لم يتم رفع أي ملف.' });
    }
    res.json({ 
      success: true, 
      message: 'تم الرفع بنجاح!',
      filename: req.file.filename
    });
  });
});

// 2. مسار جلب قائمة الملفات المرفوعة
app.get('/api/files', (req, res) => {
  try {
    fs.readdir(uploadDir, (err, files) => {
      if (err) return res.status(500).json({ success: false, error: 'خطأ في قراءة الملفات.' });
      
      const fileList = files.map(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
          createdAt: stats.birthtime
        };
      }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); // الأحدث أولاً
      
      res.json({ success: true, files: fileList });
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. مسار التفريغ المباشر (مع حل مشكلة الـ config)
app.post('/api/transcribe', async (req, res) => {
  try {
    const { filename, language } = req.body;
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'الملف غير موجود.' });
    }

    // رفع الملف لنموذج جيميناي بالطريقة الصحيحة للتحديث الجديد
    const uploadResult = await ai.files.upload({
      file: filePath,
      config: {
        mimeType: 'audio/mp3', // تم وضعها داخل الـ config كما طلب الخطأ
      }
    });

    const prompt = `قم بتفريغ هذا الملف الصوتي بدقة عالية جداً وبشكل احترافي. اللهجة أو اللغة المطلوبة هي: ${language}. قم باستخراج النص بالكامل مع تصحيح الأخطاء الإملائية وتنظيم الفقرات.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType },
        },
        { text: prompt },
      ]
    });

    res.json({ success: true, text: response.text });

  } catch (error: any) {
    res.status(500).json({ success: false, error: 'خطأ أثناء التفريغ: ' + error.message });
  }
});

const server = app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
server.timeout = 3600000;
