import fetch from 'node-fetch';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const {
  ARC_API_TOKEN,
  ELEVEN_API_KEY,
  AUDIO_BUCKET,
  ELEVEN_VOICE_ID,
  AWS_REGION
} = process.env;

const s3 = new S3Client({ region: AWS_REGION });

export const handler = async (event) => {
  try {
    const articleId = event.pathParameters.id;

    // 1. Récupérer l’article depuis Arc XP
    const arcRes = await fetch(
      `https://api.arcpublishing.com/content/v4/stories/${articleId}`,
      { headers: { Authorization: `Bearer ${ARC_API_TOKEN}` } }
    );
    if (!arcRes.ok) throw new Error(`Arc XP fetch failed: ${arcRes.status}`);
    const story = await arcRes.json();
    const { ans, subheadlines } = story;

    // 2. Construire le texte à vocaliser
    const sub = subheadlines?.basic?.trim() || '';
    const textBlocks = ans.content_elements
      .filter(el => el.type === 'text')
      .map(el => el.content.trim());
    if (sub) textBlocks.unshift(sub);
    let fullText = textBlocks.join('\n\n');
    fullText = fullText.slice(0, 4900);  // limite Eleven Labs

    // 3. Appel Eleven Labs (synchrone)
    const speechRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVEN_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: fullText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );
    if (!speechRes.ok) throw new Error(`Eleven Labs failed: ${speechRes.status}`);
    const audioBuffer = await speechRes.arrayBuffer();

    // 4. Uploader sur S3
    const key = `audio/${articleId}.mp3`;
    await s3.send(new PutObjectCommand({
      Bucket: AUDIO_BUCKET,
      Key: key,
      Body: Buffer.from(audioBuffer),
      ContentType: 'audio/mpeg'
    }));
    const audioUrl = `https://${AUDIO_BUCKET}.s3.amazonaws.com/${key}`;

    // 5. Mettre à jour l’article dans Arc XP
    const htmlBlock = {
      type: 'raw_html',
      content: `<div class="audio-access" data-subscription="le-tout-compris,l-ultime">
  <audio controls>
    <source src="${audioUrl}" type="audio/mpeg">
    Votre navigateur ne supporte pas l'audio.
  </audio>
</div>`
    };
    const updateRes = await fetch(
      `https://api.arcpublishing.com/content/v4/stories/${articleId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ARC_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content_elements: [ htmlBlock ] })
      }
    );
    if (!updateRes.ok) throw new Error(`Arc XP update failed: ${updateRes.status}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, audioUrl })
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
