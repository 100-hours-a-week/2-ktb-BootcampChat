// checkS3.js
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config({ path: '../.env' });
const {
  awsAccessKeyId,
  awsSecretAccessKey,
  s3Region,
  s3Bucket
} = require('../config/keys');

async function main() {
  const s3 = new S3Client({
    region: s3Region,
    credentials: { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey }
  });

  const key = '1753339160281_84e431b9ec4d1b28.png';

  try {
    await s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: key }));
    console.log('✅ S3에 파일이 존재합니다:', key);
  } catch (err) {
    if (err.name === 'NotFound') {
      console.log('❌ S3에 파일이 없습니다:', key);
    } else {
      console.error('Error checking S3 object:', err);
    }
  }
}

main();
