require('dotenv').config();
console.log('API Key:', process.env.OPENAI_API_KEY); // Verificação

const express = require('express');
const { IgApiClient } = require('instagram-private-api');
const fs = require('fs');
const fsPromises = fs.promises;
const bodyParser = require('body-parser');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const sizeOf = require('image-size');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require('axios');
const session = require('express-session');
const path = require('path');
const OpenAI = require('openai');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 4500;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});