// utils/youtube.js (using ytdl-core instead)
const ytdl = require('ytdl-core');

// Extract video ID from ANY YouTube URL format
function extractVideoId(url) {
  if (!url) return null;
  
  // Handle youtu.be format
  if (url.includes('youtu.be/')) {
    const match = url.match(/youtu\.be\/([^?&]+)/);
    return match ? match[1] : null;
  }
  
  // Handle youtube.com formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&]+)/,
    /(?:youtube\.com\/embed\/)([^/]+)/,
    /(?:youtube\.com\/v\/)([^/]+)/,
    /(?:youtube\.com\/shorts\/)([^?&]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  
  // Try to get v parameter from URL
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get('v');
  } catch (e) {
    return null;
  }
}

// Clean YouTube URL to standard format
function cleanYouTubeUrl(url) {
  const videoId = extractVideoId(url);
  if (videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return url;
}

async function extractYouTubeInfo(url) {
  try {
    const cleanUrl = cleanYouTubeUrl(url);
    console.log('📀 Extracting from:', cleanUrl);
    
    // Get video info
    const info = await ytdl.getInfo(cleanUrl);
    
    if (!info || !info.formats) {
      throw new Error('Could not fetch video information');
    }
    
    // Find audio-only format
    let audioFormat = info.formats.find(format => 
      format.hasAudio && !format.hasVideo
    );
    
    if (!audioFormat) {
      audioFormat = info.formats.find(format => format.hasAudio);
    }
    
    if (!audioFormat) {
      throw new Error('No audio format found');
    }
    
    // Get the audio URL - ytdl-core provides this differently
    const audioUrl = ytdl.chooseFormat(info.formats, { 
      quality: 'lowestaudio',
      filter: 'audioonly'
    }).url;
    
    console.log('✅ Found audio format');
    
    return {
      success: true,
      title: info.videoDetails.title,
      artist: info.videoDetails.author.name,
      duration: parseInt(info.videoDetails.lengthSeconds),
      thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url || '',
      audioUrl: audioUrl,
      videoId: info.videoDetails.videoId,
      cleanUrl: cleanUrl
    };
  } catch (error) {
    console.error('YouTube extraction error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = { extractYouTubeInfo, extractVideoId, cleanYouTubeUrl };