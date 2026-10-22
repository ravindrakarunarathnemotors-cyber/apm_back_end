// s3Service.js
const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

class S3Service {
    constructor() {
        // The actual S3 bucket name (e.g., ozone-desk-client-files)
        this.bucket = process.env.Client_S3_BUCKET_NAME;
        
        // Validate required environment variables
        if (!this.bucket) {
            throw new Error('Client_S3_BUCKET_NAME is not defined in environment variables');
        }
        if (!process.env.Client_S3_ACCESS_KEY) {
            throw new Error('Client_S3_ACCESS_KEY is not defined in environment variables');
        }
        if (!process.env.Client_S3_SECRET_KEY) {
            throw new Error('Client_S3_SECRET_KEY is not defined in environment variables');
        }
        if (!process.env.Client_S3_ENDPOINT) {
            throw new Error('Client_S3_ENDPOINT is not defined in environment variables');
        }
        
        this.s3Client = new S3Client({
            region: process.env.Client_S3_REGION || 'us-east-1',
            endpoint: `https://${process.env.Client_S3_ENDPOINT}`,
            credentials: {
                accessKeyId: process.env.Client_S3_ACCESS_KEY,
                secretAccessKey: process.env.Client_S3_SECRET_KEY,
            },
            forcePathStyle: true // Required for S3-compatible services like IDrive
        });
        
        console.log(`S3 Service initialized with bucket: ${this.bucket}`);
    }
    
    /**
     * Create a folder for a service
     * @param {string} serviceName - The service name (will be sanitized and used as folder name)
     * @returns {Promise<Object>} Result of folder creation
     */
    async createServiceFolder(serviceName) {
        const serviceFolder = this.sanitizeFolderName(serviceName);
        console.log(`Creating S3 folder for service: ${serviceFolder} in bucket: ${this.bucket}`);
        return await this.createFolder(serviceFolder);
    }
    
    /**
     * Create a folder in S3 bucket
     * @param {string} folderName - The folder name to create (without leading/trailing slashes)
     * @returns {Promise<Object>} Result of folder creation
     */
    async createFolder(folderName) {
        // Ensure folder name ends with a slash (S3 folder convention)
        const folderKey = `${folderName.replace(/^\/|\/$/g, '')}/`;
        
        try {
            console.log(`Creating S3 folder: ${folderKey} in bucket: ${this.bucket}`);
            
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: folderKey,
                Body: '',
                ContentType: 'application/x-directory'
            });
            
            const result = await this.s3Client.send(command);
            
            console.log(` S3 folder created successfully: s3://${this.bucket}/${folderKey}`);
            
            return {
                success: true,
                folder: folderKey,
                path: `s3://${this.bucket}/${folderKey}`,
                bucket: this.bucket,
                etag: result.ETag,
                url: `https://${process.env.Client_S3_ENDPOINT}/${this.bucket}/${folderKey}`
            };
            
        } catch (error) {
            console.error('Error creating S3 folder:', {
                bucket: this.bucket,
                folder: folderKey,
                error: error.message,
                code: error.Code,
                requestId: error.$metadata?.requestId
            });
            
            return {
                success: false,
                folder: folderKey,
                bucket: this.bucket,
                error: error.message,
                code: error.Code || 'UnknownError'
            };
        }
    }
    
    /**
     * Check if a folder exists in S3 bucket
     * @param {string} folderName - The folder name to check
     * @returns {Promise<boolean>} True if folder exists, false otherwise
     */
    async folderExists(folderName) {
        const folderKey = `${folderName.replace(/^\/|\/$/g, '')}/`;
        
        try {
            const command = new HeadObjectCommand({
                Bucket: this.bucket,
                Key: folderKey
            });
            
            await this.s3Client.send(command);
            console.log(`S3 folder exists: ${folderKey}`);
            return true;
        } catch (error) {
            if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
                console.log(`S3 folder does not exist: ${folderKey}`);
                return false;
            }
            console.error(`Error checking S3 folder existence: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Get the full S3 key for a file with service folder prefix
     * @param {string} serviceName - The service name
     * @param {string} filePath - The file path within the service folder
     * @returns {string} Full S3 key
     */
    getFullS3Key(serviceName, filePath) {
        const serviceFolder = this.sanitizeFolderName(serviceName);
        const cleanFilePath = filePath.replace(/^\/+/, '');
        return `${serviceFolder}/${cleanFilePath}`;
    }
    
    /**
     * Get the public URL for a file
     * @param {string} serviceName - The service name
     * @param {string} filePath - The file path within the service folder
     * @returns {string} Public URL
     */
    getFileUrl(serviceName, filePath) {
        const fullKey = this.getFullS3Key(serviceName, filePath);
        return `https://${process.env.Client_S3_ENDPOINT}/${this.bucket}/${fullKey}`;
    }
    
    /**
     * Sanitize folder name for S3
     * Converts to lowercase, replaces spaces with underscores, removes special characters
     * @param {string} name - The name to sanitize
     * @returns {string} Sanitized folder name
     */
    sanitizeFolderName(name) {
        if (!name) return '';
        
        return name
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '_')
            .replace(/[^a-z0-9_\-]/g, '')
            .replace(/^_+|_+$/g, ''); // Remove leading/trailing underscores
    }
    
    /**
     * Upload a file to the service folder
     * @param {string} serviceName - The service name
     * @param {string} fileName - The file name
     * @param {Buffer|string} fileContent - The file content
     * @param {string} subFolder - Optional subfolder within service folder
     * @returns {Promise<Object>} Upload result
     */
    async uploadFile(serviceName, fileName, fileContent, subFolder = '') {
        const serviceFolder = this.sanitizeFolderName(serviceName);
        const cleanSubFolder = subFolder ? `${subFolder.replace(/^\/|\/$/g, '')}/` : '';
        const fullKey = `${serviceFolder}/${cleanSubFolder}${fileName}`;
        
        try {
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: fullKey,
                Body: fileContent,
                ContentType: this.getContentType(fileName)
            });
            
            const result = await this.s3Client.send(command);
            
            return {
                success: true,
                key: fullKey,
                bucket: this.bucket,
                url: `https://${process.env.Client_S3_ENDPOINT}/${this.bucket}/${fullKey}`,
                etag: result.ETag
            };
        } catch (error) {
            console.error('Error uploading file to S3:', error);
            return {
                success: false,
                error: error.message,
                key: fullKey
            };
        }
    }
    
    /**
     * Get content type based on file extension
     * @param {string} fileName - The file name
     * @returns {string} Content type
     */
    getContentType(fileName) {
        const extension = fileName.split('.').pop().toLowerCase();
        const contentTypes = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'svg': 'image/svg+xml',
            'pdf': 'application/pdf',
            'txt': 'text/plain',
            'html': 'text/html',
            'css': 'text/css',
            'js': 'application/javascript',
            'json': 'application/json',
            'xml': 'application/xml',
            'zip': 'application/zip',
            'mp4': 'video/mp4',
            'mp3': 'audio/mpeg'
        };
        
        return contentTypes[extension] || 'application/octet-stream';
    }
}

module.exports = S3Service;