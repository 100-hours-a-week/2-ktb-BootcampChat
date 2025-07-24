const File = require('../models/File');
const Message = require('../models/Message');
const Room = require('../models/Room');
const { processFileForRAG } = require('../services/fileService');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const crypto = require('crypto');
const { uploadDir } = require('../middleware/upload');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Bucket, s3Folder, cloudfrontBaseUrl } = require('../config/keys');

const s3 = require('../services/s3Client');

const generateSafeFilename = (originalFilename) => {
  const ext = path.extname(originalFilename || '').toLowerCase();
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString('hex');
  return `${timestamp}_${randomBytes}${ext}`;
};

exports.presignUpload = async (req, res) => {
  try {
    const { filename, contentType } = req.query;
    if (!filename || !contentType) {
      return res.status(400).json({ success: false, message: 'filename, contentType 필요' });
    }

    // 스키마가 기대하는 형식(숫자_hex.확장자)으로 키 생성
    const key = generateSafeFilename(filename);
    const sub_url = `${s3Folder}/${key}`;

    const cmd = new PutObjectCommand({
      Bucket: s3Bucket,
      Key: sub_url,
      ContentType: contentType,
      ACL: 'private'
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 900 });
    res.json({ success: true, uploadUrl, key });
  } catch (err) {
    console.error('presignUpload error', err);
    res.status(500).json({ success: false, message: 'Presign URL 생성 실패' });
  }
};

exports.completeUpload = async (req, res) => {
  try {
    const { key, originalName, size, mimetype } = req.body;
    if (!key || !originalName || !size || !mimetype) {
      return res.status(400).json({ success: false, message: '메타데이터 불충분' });
    }

    // DB에 메타 저장
    const file = new File({
      filename: key,
      originalname: originalName,
      mimetype,
      size,
      user: req.user.id,
      path: key  // S3 키
    });
    await file.save();

    res.json({
    success: true,
    message: '메타 저장 완료',
    file: {
      _id: file._id,
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      uploadDate: file.uploadDate,
      url: `${cloudfrontBaseUrl}/${file.filename}`
  }
});
  } catch (err) {
    console.error('completeUpload error', err);
    res.status(500).json({ success: false, message: '메타 저장 실패' });
  }
};

const fsPromises = {
  writeFile: promisify(fs.writeFile),
  unlink: promisify(fs.unlink),
  access: promisify(fs.access),
  mkdir: promisify(fs.mkdir),
  rename: promisify(fs.rename)
};

const isPathSafe = (filepath, directory) => {
  const resolvedPath = path.resolve(filepath);
  const resolvedDirectory = path.resolve(directory);
  return resolvedPath.startsWith(resolvedDirectory);
};

// 개선된 파일 정보 조회 함수
const getFileFromRequest = async (req) => {
  try {
    const filename = req.params.filename;
    const token = req.headers['x-auth-token'] || req.query.token;
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    
    if (!filename) {
      throw new Error('Invalid filename');
    }

    if (!token || !sessionId) {
      throw new Error('Authentication required');
    }

    const filePath = path.join(uploadDir, filename);
    if (!isPathSafe(filePath, uploadDir)) {
      throw new Error('Invalid file path');
    }

    await fsPromises.access(filePath, fs.constants.R_OK);

    const file = await File.findOne({ filename: filename });
    if (!file) {
      throw new Error('File not found in database');
    }
//
//    // 채팅방 권한 검증을 위한 메시지 조회
//    const message = await Message.findOne({ file: file._id });
//    if (!message) {
//      throw new Error('File message not found');
//    }
//
//    // 사용자가 해당 채팅방의 참가자인지 확인
//    const room = await Room.findOne({
//      _id: message.room,
//      participants: req.user.id
//    });
//
//    if (!room) {
//      throw new Error('Unauthorized access');
//    }

    return { file, filePath };
  } catch (error) {
    console.error('getFileFromRequest error:', {
      filename: req.params.filename,
      error: error.message
    });
    throw error;
  }
};

exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '파일이 선택되지 않았습니다.'
      });
    }

    const safeFilename = generateSafeFilename(req.file.originalname);
    const currentPath = req.file.path;
    const newPath = path.join(uploadDir, safeFilename);

    const file = new File({
      filename: safeFilename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      user: req.user.id,
      path: newPath
    });

    await file.save();
    await fsPromises.rename(currentPath, newPath);

    res.status(200).json({
      success: true,
      message: '파일 업로드 성공',
      file: {
        _id: file._id,
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        uploadDate: file.uploadDate
      }
    });

  } catch (error) {
    console.error('File upload error:', error);
    if (req.file?.path) {
      try {
        await fsPromises.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('Failed to delete uploaded file:', unlinkError);
      }
    }
    res.status(500).json({
      success: false,
      message: '파일 업로드 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    const fileUrl = `${cloudfrontBaseUrl}/${file.filename}`;
    return res.redirect(fileUrl);
  } catch (error) {
    handleFileError(error, res);
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    if (!file.isPreviewable()) {
      return res.status(415).json({
        success: false,
        message: '미리보기를 지원하지 않는 파일 형식입니다.'
      });
    }

    const fileUrl = `${cloudfrontBaseUrl}/${file.filename}`;
    // 302 Redirect
    return res.redirect(fileUrl);

  } catch (error) {
    handleFileError(error, res);
  }
};

const handleFileStream = (fileStream, res) => {
  fileStream.on('error', (error) => {
    console.error('File streaming error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: '파일 스트리밍 중 오류가 발생했습니다.'
      });
    }
  });

  fileStream.pipe(res);
};

const handleFileError = (error, res) => {
  console.error('File operation error:', {
    message: error.message,
    stack: error.stack
  });

  // 에러 상태 코드 및 메시지 매핑
  const errorResponses = {
    'Invalid filename': { status: 400, message: '잘못된 파일명입니다.' },
    'Authentication required': { status: 401, message: '인증이 필요합니다.' },
    'Invalid file path': { status: 400, message: '잘못된 파일 경로입니다.' },
    'File not found in database': { status: 404, message: '파일을 찾을 수 없습니다.' },
    'File message not found': { status: 404, message: '파일 메시지를 찾을 수 없습니다.' },
    'Unauthorized access': { status: 403, message: '파일에 접근할 권한이 없습니다.' },
    'ENOENT': { status: 404, message: '파일을 찾을 수 없습니다.' }
  };

  const errorResponse = errorResponses[error.message] || {
    status: 500,
    message: '파일 처리 중 오류가 발생했습니다.'
  };

  res.status(errorResponse.status).json({
    success: false,
    message: errorResponse.message
  });
};

exports.deleteFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({
        success: false,
        message: '파일을 찾을 수 없습니다.'
      });
    }

    if (file.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: '파일을 삭제할 권한이 없습니다.'
      });
    }

    const filePath = path.join(uploadDir, file.filename);

    if (!isPathSafe(filePath, uploadDir)) {
      return res.status(403).json({
        success: false,
        message: '잘못된 파일 경로입니다.'
      });
    }
    
    try {
      await fsPromises.access(filePath, fs.constants.W_OK);
      await fsPromises.unlink(filePath);
    } catch (unlinkError) {
      console.error('File deletion error:', unlinkError);
    }

    await file.deleteOne();

    res.json({
      success: true,
      message: '파일이 삭제되었습니다.'
    });
  } catch (error) {
    console.error('File deletion error:', error);
    res.status(500).json({
      success: false,
      message: '파일 삭제 중 오류가 발생했습니다.',
      error: error.message
    });
  }
};
