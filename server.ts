import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';

// حل مشكلة __dirname في بيئة ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, '../uploads');
const trimmedDir = path.join(__dirname, '../trimmed');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(trimmedDir)) fs.mkdirSync(trimmedDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/', (req, res) => {
  res.send('سيرفر التفريغ والقص يعمل بنجاح.');
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

app.post('/api/upload', upload.single('audioFile'), (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'لم يتم رفع أي ملف.' });
    }
    res.json({ 
      success: true, 
      message: 'تم رفع الملف بنجاح!',
      fileId: req.file.filename,
      originalName: req.file.originalname 
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/files', (req, res) => {
  try {
    fs.readdir(uploadDir, (err, files) => {
      if (err) return res.status(500).json({ success: false, error: 'خطأ في قراءة مجلد الملفات.' });
      
      const fileList = files.map(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        return {
          fileId: file,
          originalName: file.substring(file.indexOf('-') + 1),
          size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
          createdAt: stats.birthtime
        };
      });
      res.json({ success: true, files: fileList });
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/trim-and-transcribe/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { startTime, duration } = req.body; 

    const inputPath = path.join(uploadDir, fileId);
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ success: false, error: 'الملف غير موجود على السيرفر.' });
    }

    const outputPath = path.join(trimmedDir, `trimmed-${Date.now()}-${fileId}`);

    ffmpeg(inputPath)
      .setStartTime(startTime) 
      .setDuration(duration)   
      .output(outputPath)
      .on('end', async () => {
        try {
          const uploadResult = await ai.files.upload({
            file: outputPath,
            mimeType: 'audio/mp4',
          });

          const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [
              {
                fileData: {
                  fileUri: uploadResult.uri,
                  mimeType: uploadResult.mimeType,
                },
              },
              { text: "قم بتفريغ هذا الملف الصوتي بدقة عالية واستخراج النصوص والشرائح بشكل زمني منظم." },
            ],
            config: { 
              responseMimeType: 'application/json' 
            }
          });

          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

          res.json({ success: true, data: JSON.parse(response.text || '{}') });
        } catch (aiError: any) {
          res.status(500).json({ success: false, error: 'خطأ المعالجة الذكية: ' + aiError.message });
        }
      })
      .on('error', (err: any) => {
        res.status(500).json({ success: false, error: 'خطأ أثناء قص الملف: ' + err.message });
      })
      .run();
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const server = app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

server.timeout = 1800000;
server.keepAliveTimeout = 1800000;
server.headersTimeout = 1805000;
