const express = require("express");
const upload = require("../middleware/uploadMiddleware");  // Ensure middleware exists
const { uploadFile } = require("../controllers/uploadController"); //  Correct Import


const router = express.Router();

router.post("/upload", upload.single("file"), uploadFile); //  Fix the callback function


module.exports = router;
