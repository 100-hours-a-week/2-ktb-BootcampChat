const { S3Client } = require('@aws-sdk/client-s3');
const { awsAccessKeyId, awsSecretAccessKey, s3Region } = require('../config/keys');

const s3 = new S3Client({
  region: s3Region,
  credentials: { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey }
});

module.exports = s3;
