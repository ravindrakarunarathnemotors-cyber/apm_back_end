require("dotenv").config();

const {
    S3Client,
    PutObjectCommand,
} = require("@aws-sdk/client-s3");

// AWS S3 Client
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

exports.uploadFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: "No file uploaded.",
            });
        }

        const folderName = "saasbilling";
        const fileName = `${Date.now()}-${req.file.originalname}`;
        const key = `${folderName}/${fileName}`;

        const params = {
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        };

        console.log("🚀 Uploading to AWS S3:", {
            Bucket: params.Bucket,
            Key: params.Key,
            ContentType: params.ContentType,
        });

        const command = new PutObjectCommand(params);

        await s3.send(command);

        const fileUrl =
    `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;


        console.log("✅ Upload successful:", fileUrl);

        return res.json({
            success: true,
            fileUrl,
            key,
        });

    } catch (error) {
        console.error("❌ Upload failed:", error);

        return res.status(500).json({
            error: "File upload failed",
            message: error.message,
        });
    }
};
