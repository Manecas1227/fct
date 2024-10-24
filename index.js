require("dotenv").config();
process.env.TZ = 'Europe/Lisbon';
const express = require('express');
const fs = require('fs').promises;
const bodyParser = require('body-parser');
const multer = require('multer');
const sharp = require('sharp');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require('axios');
const session = require('express-session');
const path = require('path');
const { translate } = require('google-translate-api-x');
const { IgApiClient } = require('instagram-private-api');
const cron = require('node-cron');
const parser = require('cron-parser');
const moment = require('moment-timezone');
const { Configuration, OpenAIApi } = require("openai");
const sizeOf = require('image-size');
const rateLimit = require('express-rate-limit');


const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100 // limite de 100 requisições por janela
});

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 4500;

// Configuração do Multer com respetivos limites
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
    fieldSize: 10 * 1024 * 1024 // 10 MB
  }
});

app.set('view engine', 'ejs');
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: 'segredo',
  resave: false,
  saveUninitialized: true
}));

// Funções auxiliares

const checkMediaDimensions = async (mediaPath, mediaType) => {
  try {
    if (mediaType === 'image') {
      const dimensions = await sharp(mediaPath).metadata();
      const { width, height } = dimensions;
      const minDimension = 320;
      const maxDimension = 1080;
      if (width < minDimension || height < minDimension || width > maxDimension || height > maxDimension) {
        return { success: false, message: `As dimensões da imagem (${width}x${height}) não são compatíveis com os requisitos do Instagram.` };
      }
    }
    return { success: true };
  } catch (err) {
    console.error(`Erro ao verificar as dimensões da mídia: ${err.message}`);
    return { success: false, message: `Erro ao verificar as dimensões da mídia: ${err.message}` };
  }
};

const generateThumbnail = (videoPath) => {
  return new Promise((resolve, reject) => {
    const thumbnailPath = videoPath + '_thumbnail.jpg';
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['00:00:01'],
        filename: thumbnailPath,
        size: '1080x1080'
      })
      .on('end', () => resolve(thumbnailPath))
      .on('error', (err) => reject(err));
  });
};

const translateToEnglish = async (text) => {
  if (!text) return '';
  try {
    const result = await translate(text, { to: 'en' });
    return result.text;
  } catch (error) {
    console.error('Erro na tradução:', error);
    return text;
  }
};

const generateImageWithAI = async (prompt) => {
  if (!prompt || prompt.trim() === '') {
    throw new Error('Prompt não pode estar vazio');
  }

  try {
    const translatedPrompt = await translateToEnglish(prompt);
    console.log(`Prompt original: "${prompt}"`);
    console.log(`Prompt traduzido: "${translatedPrompt}"`);

    const response = await axiosRetry({
      method: 'post',
      url: 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${process.env.STABILITY_API_KEY}`,
      },
      data: {
        text_prompts: [
          {
            text: translatedPrompt,
          },
        ],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        samples: 1,
        steps: 30,
      },
    });

    if (response.data && response.data.artifacts && response.data.artifacts.length > 0) {
      const base64Image = response.data.artifacts[0].base64;
      const buffer = Buffer.from(base64Image, 'base64');
      const imagePath = './uploads/ai_generated_image.png';
      await fs.writeFile(imagePath, buffer);
      return imagePath;
    } else {
      console.error('Resposta da API não contém imagens:', response.data);
      throw new Error('Nenhuma imagem gerada pela API');
    }
  } catch (error) {
    console.error('Erro detalhado ao gerar imagem com IA:', error.response ? error.response.data : error.message);
    throw new Error(`Falha ao gerar imagem: ${error.message}`);
  }
};

const addTextToImage = async (image, text, fontSize = 32, color = 'white', metadata) => {
  const maxWidth = metadata.width - 40;
  const lineHeight = fontSize * 1.2;
  
  const wrapText = (text, maxWidth) => {
      const words = text.split(' ');
      const lines = [];
      let currentLine = '';

      words.forEach(word => {
          const testLine = currentLine ? `${currentLine} ${word}` : word;
          const testWidth = testLine.length * (fontSize / 2);

          if (testWidth <= maxWidth) {
              currentLine = testLine;
          } else {
              lines.push(currentLine);
              currentLine = word;
          }
      });
      lines.push(currentLine);

      return lines;
  };

  const lines = wrapText(text, maxWidth);
  const totalTextHeight = lines.length * lineHeight;
  const startY = (metadata.height - totalTextHeight) / 2;

  const svgText = `
      <svg width="${metadata.width}" height="${metadata.height}">
          <style>
              .text { fill: ${color}; font-size: ${fontSize}px; font-family: Arial, sans-serif; }
          </style>
          ${lines.map((line, index) => 
              `<text 
                  x="50%" 
                  y="${startY + (index + 0.5) * lineHeight}" 
                  text-anchor="middle" 
                  class="text"
              >${line}</text>`
          ).join('')}
      </svg>
  `;

  return image.composite([
      { input: Buffer.from(svgText), top: 0, left: 0 },
  ]);
};

const addLogoToImage = async (image, logoBuffer, metadata) => {
  const logoSize = Math.round(metadata.width * 0.2);
  
  const logo = await sharp(logoBuffer)
    .resize(logoSize, logoSize, { fit: 'inside' })
    .toBuffer();

  const logoMetadata = await sharp(logo).metadata();

  return image.composite([
    {
      input: logo, 
      top: 10, 
      left: metadata.width - logoMetadata.width - 10
    },
  ]);
};

const axiosRetry = async (config, maxRetries = 3, initialDelay = 1000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios(config);
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const delay = initialDelay * Math.pow(2, i);
        console.log(`Tentativa ${i + 1} falhou. Aguardando ${delay}ms antes de tentar novamente.`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Falha após ${maxRetries} tentativas`);
};

const generateTextWithAI = async (prompt) => {
  try {
    const response = await axiosRetry({
      method: 'post',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      data: {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,  // Aumentado de 50 para 200
        temperature: 0.7
      }
    });
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro ao gerar texto com IA:', error);
    throw error;
  }
};

const processImage = async (mediaBuffer, logoBuffer, imageText, fontSize, textColor, fontFamily) => {
  try {
    // Otimizar a imagem primeiro
    let optimizedBuffer = await optimizeImage(mediaBuffer);
    
    let image = sharp(optimizedBuffer);
    const metadata = await image.metadata();

    // Criar um novo buffer para a imagem processada
    let processedBuffer = await image.toBuffer();

    // Adicionar texto, se fornecido e for uma string válida
    if (imageText && typeof imageText === 'string' && imageText.trim() !== '') {
      const dimensions = sizeOf(optimizedBuffer);
      const maxWidth = dimensions.width * 0.9; // 90% da largura da imagem
      let currentFontSize = parseInt(fontSize);
      const lines = wrapText(imageText, maxWidth, currentFontSize);

      const lineHeight = currentFontSize * 1.2;
      const totalTextHeight = lines.length * lineHeight;
      const startY = (dimensions.height - totalTextHeight) / 2;

      const svgText = `
        <svg width="${dimensions.width}" height="${dimensions.height}">
          <style>
            .text { fill: ${textColor}; font-size: ${currentFontSize}px; font-family: ${fontFamily}, Arial, sans-serif; }
          </style>
          ${lines.map((line, index) => 
            `<text 
              x="50%" 
              y="${startY + (index + 0.5) * lineHeight}" 
              text-anchor="middle" 
              class="text"
            >${escapeXml(line)}</text>`
          ).join('')}
        </svg>
      `;

      processedBuffer = await sharp(processedBuffer)
        .composite([{ 
          input: Buffer.from(svgText), 
          top: 0, 
          left: 0 
        }])
        .toBuffer();
    }

    // Adicionar logo, se fornecido (no canto superior direito)
    if (logoBuffer) {
      try {
        const logoSize = Math.round(metadata.width * 0.2);
        const resizedLogo = await sharp(logoBuffer)
          .resize(logoSize, logoSize, { fit: 'inside' })
          .toBuffer();

        const logoMetadata = await sharp(resizedLogo).metadata();

        processedBuffer = await sharp(processedBuffer)
          .composite([
            {
              input: resizedLogo,
              top: 10,
              left: metadata.width - logoMetadata.width - 10
            }
          ])
          .toBuffer();
      } catch (logoError) {
        console.error('Error processing logo:', logoError);
        // If there's an error with the logo, we'll continue without it
      }
    }

    return processedBuffer;
  } catch (error) {
    console.error('Error processing image:', error);
    throw new Error('Failed to process the image');
  }
};

// Função auxiliar para quebrar o texto em linhas
const wrapText = (text, maxWidth, fontSize) => {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  words.forEach(word => {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = testLine.length * (fontSize / 2); // Estimativa aproximada da largura do texto

      if (testWidth <= maxWidth) {
          currentLine = testLine;
      } else {
          lines.push(currentLine);
          currentLine = word;
      }
  });
  lines.push(currentLine);

  return lines;
};

// Função para escapar caracteres especiais XML
const escapeXml = (unsafe) => {
  return unsafe.replace(/[<>&'"]/g, function (c) {
      switch (c) {
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '&': return '&amp;';
          case '\'': return '&apos;';
          case '"': return '&quot;';
      }
  });
};

const optimizeImage = async (inputBuffer) => {
  try {
    const image = sharp(inputBuffer);
    const metadata = await image.metadata();

    // Redimensionar a imagem se for maior que 1080x1080
    let resizedImage = image.resize({
      width: Math.min(metadata.width, 1080),
      height: Math.min(metadata.height, 1080),
      fit: 'inside',
      withoutEnlargement: true
    });

    // Aplicar ajustes para melhorar a qualidade
    resizedImage = resizedImage
      .sharpen() // Aumenta a nitidez
      .modulate({
        brightness: 1.05, // Aumenta levemente o brilho
        saturation: 1.1 // Aumenta levemente a saturação
      })
      .jpeg({ quality: 85, progressive: true }); // Comprime como JPEG de alta qualidade

    return resizedImage.toBuffer();
  } catch (error) {
    console.error('Erro ao otimizar imagem:', error);
    throw error;
  }
};

const postToInsta = async (mediaPath, caption, mediaType, thumbnailPath, username, password) => {
  console.log('Iniciando postagem no Instagram');
  console.log(`Tipo de mídia: ${mediaType}`);
  console.log(`Legenda: ${caption}`);
  const ig = new IgApiClient();
  ig.state.generateDevice(username);  

  try {
    console.log('Fazendo login no Instagram');
    await ig.simulate.preLoginFlow();
    const loggedInUser = await ig.account.login(username, password);
    console.log('Login bem-sucedido');

    let result;
    if (mediaType === 'image') {
      try {
        await fs.access(mediaPath);
      } catch (error) {
        console.error(`Erro ao acessar o arquivo de mídia: ${error.message}`);
        return { success: false, message: `Arquivo de mídia não encontrado ou inacessível: ${mediaPath}` };
      }
      let mediaBuffer = await fs.readFile(mediaPath);
      console.log('Arquivo de mídia lido com sucesso');
      
      mediaBuffer = await optimizeImage(mediaBuffer);
      
      const metadata = await sharp(mediaBuffer).metadata();

      console.log('A iniciar upload da foto');

      const uploadWithRetry = async (maxRetries = 3) => {
        for (let i = 0; i < maxRetries; i++) {
          try {
            const publishResult = await ig.publish.photo({
              file: mediaBuffer,
              caption: caption,
            });
            console.log('Upload bem sucedido', publishResult);
            return publishResult;
          } catch (error) {
            console.error(`Tentativa de Upload ${i + 1} Falhou:`, error.message);
            if (error.response) {
              console.error('Instagram API Error:', error.response.body);
            }
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
          }
        }
      };

      result = await uploadWithRetry();
    } else if (mediaType === 'video') {
      let coverPath = thumbnailPath;
      if (!coverPath) {
        try {
          coverPath = await generateThumbnail(mediaPath);
        } catch (thumbnailError) {
          console.error('Erro ao gerar thumbnail:', thumbnailError);
          return { success: false, message: `Erro ao gerar thumbnail: ${thumbnailError.message}` };
        }
      }
      const videoBuffer = await fs.readFile(mediaPath);
      const coverBuffer = await fs.readFile(coverPath);
      
      result = await ig.publish.video({
        video: videoBuffer,
        coverImage: coverBuffer,
        caption: caption,
      });

      if (!thumbnailPath) {
        await fs.unlink(coverPath);
      }
    }

    console.log('Mídia postada com sucesso', result);
    return { success: true, message: 'Mídia postada com sucesso', result };
  } catch (e) {
    console.error('Erro detalhado ao postar a mídia no Instagram:', e);
    if (e.response) {
      console.error('Resposta do Instagram:', e.response.body);
    }
    return { success: false, message: `Erro ao postar a mídia: ${e.message}` };
  } finally {
    try {
      await ig.simulate.postLoginFlow();
    } catch (postLoginError) {
      if (postLoginError.name === 'IgNotFoundError' && postLoginError.message.includes('/api/v1/fbsearch/suggested_searches/?type=users')) {
        console.log('Aviso: Erro no fluxo pós-login (sugestões de pesquisa não encontradas). Este erro não afeta o upload da mídia e pode ser ignorado.');
      } else {
        console.error('Erro inesperado no fluxo pós-login:', postLoginError);
      }
    }
  }
};



async function getScheduledPosts() {
  const schedulePath = path.join(__dirname, 'scheduled_posts.json');
  let scheduledPosts = [];
  
  try {
    const data = await fs.readFile(schedulePath, 'utf8');
    scheduledPosts = JSON.parse(data);
    
    let modified = false;
    scheduledPosts = scheduledPosts.map(post => {
      if (!post.id) {
        post.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        modified = true;
      }
      return post;
    });

    if (modified) {
      await fs.writeFile(schedulePath, JSON.stringify(scheduledPosts, null, 2));
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('A iniciar novo arquivo de agendamento');
      await fs.writeFile(schedulePath, JSON.stringify([], null, 2));
    } else {
      console.error('Erro ao ler posts agendados:', error);
    }
  }

  return scheduledPosts;
}

async function schedulePost(postData) {
  const schedulePath = path.join(__dirname, 'scheduled_posts.json');
  let scheduledPosts = [];

  try {
    scheduledPosts = await getScheduledPosts();
  } catch (error) {
    console.log('A iniciar novo arquivo de agendamento');
  }

  postData.id = Date.now().toString();
  postData.mediaPath = postData.mediaPath || '';
  scheduledPosts.push(postData);
  await fs.writeFile(schedulePath, JSON.stringify(scheduledPosts, null, 2));
  console.log(`Post agendado: ${JSON.stringify(postData)}`);
}

async function cancelScheduledPost(postId) {
  const schedulePath = path.join(__dirname, 'scheduled_posts.json');
  try {
    let scheduledPosts = await getScheduledPosts();
    scheduledPosts = scheduledPosts.filter(post => post.id !== postId);
    await fs.writeFile(schedulePath, JSON.stringify(scheduledPosts, null, 2));
    console.log(`Post de ID ${postId} cancelado`);
    return true;
  } catch (error) {
    console.error('Erro ao cancelar o post:', error);
    return false;
  }
}

// Middleware de autenticação
const requireAuth = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/cadastro');
  }
};

// Rotas

app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/index');
  } else {
    res.redirect('/cadastro');
  }
});

app.get('/cadastro', (req, res) => {
  res.render('cadastro', { user: null, success: null, message: null });
});

app.post('/generate-ai-text', requireAuth, async (req, res) => {
  try {
    const prompt =  req.body.prompt;
    const generatedText = await generateTextWithAI(prompt);
    res.json({ success: true, text: generatedText });
  } catch (error) {
    console.error('Erro ao gerar texto com IA:', error);
    res.json({ success: false, message: 'Erro ao gerar texto com IA' });
  }
});

app.post('/cadastrar-conta', upload.single('logo'), (req, res) => {
  const { igUsername, igPassword } = req.body;
  const logoPath = req.file ? req.file.path : null;
  req.session.user = { igUsername, igPassword, logoPath };
  res.render('index', { 
    user: req.session.user, 
    success: true, 
    message: 'Credenciais salvas com sucesso!'
  });
});

app.get('/index', requireAuth, (req, res) => {
  res.render('index', { user: req.session.user, success: null, message: null });
});

app.get('/editar-credenciais', requireAuth, (req, res) => {
  res.render('cadastro', { user: req.session.user, success: null, message: null });
});

app.post('/editar-credenciais', upload.single('logo'), (req, res) => {
  const { igUsername, igPassword } = req.body;
  const logoPath = req.file ? `/uploads/${req.file.filename}` : req.session.user.logoPath;
  req.session.user = { ...req.session.user, igUsername, igPassword, logoPath };
  res.render('index', { 
    user: req.session.user, 
    success: true, 
    message: 'Credenciais atualizadas com sucesso!'
  });
});

app.post('/edit-post-schedule', requireAuth, async (req, res) => {
  const { postId, scheduleOption, customTime, weekdays } = req.body;

  try {
      let scheduledPosts = await getScheduledPosts();
      const postIndex = scheduledPosts.findIndex(post => post.id === postId);

      if (postIndex === -1) {
          return res.json({ success: false, message: 'Post não encontrado' });
      }

      const cronExpression = createCronExpression(scheduleOption, customTime, weekdays);
      if (cronExpression) {
          scheduledPosts[postIndex].cronSchedule = cronExpression;
          await fs.writeFile(path.join(__dirname, 'scheduled_posts.json'), JSON.stringify(scheduledPosts, null, 2));
          res.json({ success: true, message: 'Agendamento atualizado com sucesso' });
      } else {
          res.json({ success: false, message: 'Falha ao criar agendamento' });
      }
  } catch (error) {
      console.error('Erro ao atualizar agendamento:', error);
      res.json({ success: false, message: `Erro ao atualizar agendamento: ${error.message}` });
  }
});


app.post('/generate-image', requireAuth, async (req, res) => {
  const { aiPrompt } = req.body;
  
  if (!aiPrompt || aiPrompt.trim() === '') {
    return res.json({ success: false, message: 'O prompt não pode estar vazio' });
  }

  try {
    const imagePath = await generateImageWithAI(aiPrompt);
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    res.json({ success: true, image: base64Image });
  } catch (error) {
    console.error('Erro ao gerar imagem com IA:', error);
    res.json({ success: false, message: error.message });
  }
});

app.use(apiLimiter);

app.get('/scheduled-posts', requireAuth, async (req, res) => {
  try {
    const scheduledPosts = await getScheduledPosts();
    res.render('scheduled-posts', { user: req.session.user, posts: scheduledPosts });
  } catch (error) {
    res.render('scheduled-posts', { user: req.session.user, posts: [] });
  }
});

app.post('/cancel-post', requireAuth, async (req, res) => {
  const { postId } = req.body;
  const success = await cancelScheduledPost(postId);
  res.json({ success });
});

app.get('/scheduled-media/:id', requireAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const scheduledPosts = await getScheduledPosts();
    const post = scheduledPosts.find(p => p.id === postId);

    if (!post) {
      return res.status(404).send('Mídia não encontrada');
    }

    res.sendFile(path.resolve(post.mediaPath));
  } catch (error) {
    console.error('Erro ao servir mídia agendada:', error);
    res.status(500).send('Erro ao carregar mídia');
  }
});

app.post('/post-insta', requireAuth, upload.fields([
  { name: 'media', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'logoFile', maxCount: 1 }
]), async (req, res) => {
  const { legenda, mediaSource, aiPrompt, aiGeneratedImage, scheduleOption, customTime, weekdays, imageText, fontSize, textColor, fontFamily, useDefaultLogo } = req.body;
  const { igUsername, igPassword, logoPath } = req.session.user;

  let mediaBuffer, mediaType, logoBuffer;

  try {
    if (mediaSource === 'ai') {
      mediaBuffer = Buffer.from(aiGeneratedImage, 'base64');
      mediaType = 'image';
    } else {
      if (!req.files['media']) {
        throw new Error('Nenhum arquivo de mídia foi enviado');
      }
      mediaBuffer = await fs.readFile(req.files['media'][0].path);
      mediaType = req.files['media'][0].mimetype.startsWith('image/') ? 'image' : 'video';
    }

    const thumbnailPath = req.files['thumbnail'] ? req.files['thumbnail'][0].path : null;

    // Lidar com a logo
    if (useDefaultLogo === 'on' && logoPath) {
      console.log('Usando logo padrão:', logoPath);
      try {
        logoBuffer = await fs.readFile(path.join(__dirname, logoPath));
        console.log('Logo padrão carregada com sucesso');
      } catch (error) {
        console.error('Erro ao carregar logo padrão:', error);
      }
    } else if (req.files['logoFile']) {
      console.log('Usando logo enviada');
      logoBuffer = await fs.readFile(req.files['logoFile'][0].path);
    }

    // Processar a imagem
    if (mediaType === 'image') {
      const textToAdd = typeof imageText === 'string' ? imageText : '';
      mediaBuffer = await processImage(mediaBuffer, logoBuffer, textToAdd, parseInt(fontSize), textColor, fontFamily);
    }

    // Salvar a imagem processada
    const mediaPath = `./uploads/${Date.now()}_processed_image.jpg`;
    await fs.writeFile(mediaPath, mediaBuffer);

    const postData = {
      mediaPath,
      mediaType,
      legenda,
      thumbnailPath,
      igUsername,
      igPassword
    };

    if (scheduleOption === 'now') {
      const result = await postToInsta(mediaPath, legenda, mediaType, thumbnailPath, igUsername, igPassword);
      res.json(result);
    } else {
      try {
        const cronExpression = createCronExpression(scheduleOption, customTime, weekdays);
        if (cronExpression) {
          postData.cronSchedule = cronExpression;
          await schedulePost(postData);
          res.json({ success: true, message: 'Post agendado com sucesso' });
        } else {
          throw new Error('Falha ao criar expressão cron');
        }
      } catch (cronError) {
        console.error('Erro ao criar expressão cron:', cronError);
        res.json({ success: false, message: `Erro ao agendar o post: ${cronError.message}` });
      }
    }
  } catch (error) {
    console.error('Erro ao processar a postagem:', error);
    return res.json({ success: false, message: `Erro ao processar a postagem: ${error.message}` });
  }
});

function createCronExpression(scheduleOption, customTime, weekdays) {
  let cronExpression;
  switch (scheduleOption) {
      case 'daily':
          cronExpression = '0 12 * * *'; // Todos os dias às 12:00
          break;
      case 'weekly':
          cronExpression = '0 12 * * 1'; // Toda segunda-feira às 12:00
          break;
      case 'custom':
          if (!customTime) {
              throw new Error('Horário personalizado não foi especificado');
          }
          const [hours, minutes] = customTime.split(':');
          if (!weekdays || !Array.isArray(weekdays) || weekdays.length === 0) {
              throw new Error('Dias da semana não foram selecionados para o agendamento personalizado');
          }
          const days = weekdays.join(',');
          cronExpression = `${minutes} ${hours} * * ${days}`;
          break;
      default:
          throw new Error('Opção de agendamento inválida');
  }
  return cronExpression;
}



cron.schedule('* * * * *', async () => {
  try {
    let scheduledPosts = await getScheduledPosts();
    
    const now = moment().tz('Europe/Lisbon').format('YYYY-MM-DD HH:mm');
    
    for (const post of scheduledPosts) {      
      if (cron.validate(post.cronSchedule)) {
        const interval = parser.parseExpression(post.cronSchedule, { tz: 'Europe/Lisbon' });
        const nextRun = moment(interval.next().toDate()).format('YYYY-MM-DD HH:mm');
        const prevRun = moment(interval.prev().toDate()).format('YYYY-MM-DD HH:mm');
        
        if (now === nextRun || now === prevRun) {
          console.log('É hora de postar');
          try {
            const result = await postToInsta(post.mediaPath, post.legenda, post.mediaType, post.thumbnailPath, post.igUsername, post.igPassword);
            if (result.success) {
              console.log('Post agendado publicado com sucesso');
            } else {
              console.error('Falha ao publicar post agendado:', result.message);
            }
          } catch (error) {
            console.error('Erro ao publicar post agendado:', error);
          }
        } else {
          console.log(`Ainda não está na hora de postar.`);
        }
      } else {
        console.error(`Expressão cron inválida: ${post.cronSchedule}`);
      }
    }
    
    // Atualizar a lista de posts agendados
    const schedulePath = path.join(__dirname, 'scheduled_posts.json');
    await fs.writeFile(schedulePath, JSON.stringify(scheduledPosts, null, 2));
  } catch (error) {
    console.error('Erro no cron job:', error);
  }
});

app.listen(port, () => {
  console.log(`Servidor a trabalhar na porta ${port}`);
});