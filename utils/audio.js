// utils/audio.js - Multiple instances with retry logic
const instances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.moomoo.me',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.syncpundit.io',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.ducks.party'
];

async function getAudioUrl(videoId) {
    // Try each instance until one works
    for (const instance of instances) {
        try {
            console.log(`🎵 Trying ${instance}...`);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
            
            const response = await fetch(`${instance}/streams/${videoId}`, {
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                console.log(`❌ ${instance} returned ${response.status}`);
                continue;
            }
            
            const data = await response.json();
            
            // Find best audio stream
            const audioStream = data.audioStreams?.find(stream => 
                stream.format === 'opus' || stream.format === 'm4a'
            ) || data.audioStreams?.[0];
            
            if (audioStream?.url) {
                console.log(`✅ Got audio from ${instance} (${audioStream.quality || 'unknown'})`);
                return audioStream.url;
            }
            
        } catch (error) {
            console.log(`❌ ${instance} failed: ${error.message}`);
            continue;
        }
    }
    
    // If all Piped instances fail, try y2mate alternative
    console.log('🔄 All Piped instances failed, trying alternative...');
    return await getAudioUrlAlternative(videoId);
}

// Alternative method using y2mate API
async function getAudioUrlAlternative(videoId) {
    try {
        // Using a different free API
        const response = await fetch(`https://yt-api.vercel.app/api/audio/${videoId}`);
        const data = await response.json();
        
        if (data.url) {
            console.log('✅ Got audio from yt-api');
            return data.url;
        }
        return null;
    } catch (error) {
        console.error('Alternative also failed:', error.message);
        return null;
    }
}

module.exports = { getAudioUrl };