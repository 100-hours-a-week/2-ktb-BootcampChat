// backend/routes/api/files.js
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const fileController = require('../../controllers/fileController');
const { upload, errorHandler } = require('../../middleware/upload');

// 파일 업로드
router.post('/upload',
  auth,
  upload.single('file'),
  errorHandler,
  fileController.uploadFile
);

// 파일 다운로드
router.get('/download/:filename',
  auth,
  fileController.downloadFile
);

// 파일 보기 (미리보기용)
router.get('/view/:filename',
  auth,
  fileController.viewFile
);

// 파일 삭제
router.delete('/:id',
  auth,
  fileController.deleteFile
);

// 1) Presign URL 요청
router.get(
  '/presign-upload',
  auth,
  fileController.presignUpload
);

// 2) 업로드 완료 후 메타 등록
router.post(
  '/complete-upload',
  auth,
  fileController.completeUpload
);

module.exports = router;
