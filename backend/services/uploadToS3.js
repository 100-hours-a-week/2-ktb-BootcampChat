const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2 사용해야 함

const filePath = path.resolve(__dirname, '../uploads/1753349712365_4763afa166329a99.pdf');
const uploadUrl = 'https://boot-2-upload-bucket.s3.ap-northeast-2.amazonaws.com/uploads/1753349712365_4763afa166329a99.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIA2DUUDVCQ7TSXEOGH%2F20250724%2Fap-northeast-2%2Fs3%2Faws4_request&X-Amz-Date=20250724T093512Z&X-Amz-Expires=900&X-Amz-Signature=cf0f7cc468ed2e6cc347225336ba338be7e70df51361d35c60bedaca71d9fc16&X-Amz-SignedHeaders=host&x-amz-acl=private&x-amz-checksum-crc32=AAAAAA%3D%3D&x-amz-sdk-checksum-algorithm=CRC32&x-id=PutObject';
async function uploadFile() {
  try {
    const fileStream = fs.createReadStream(filePath);
    const stat = fs.statSync(filePath);
    const contentType = 'application/pdf'; // 실제 확장자와 일치해야 함

    console.log(`🔄 업로드 시작: ${filePath}`);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': stat.size,
      },
      body: fileStream,
    });

    if (res.ok) {
      console.log('✅ S3 업로드 성공');
    } else {
      console.error('❌ 업로드 실패:', res.status, await res.text());
    }
  } catch (err) {
    console.error('🚨 업로드 중 오류 발생:', err);
  }
}

uploadFile();
