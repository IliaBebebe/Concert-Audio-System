const { parentPort, workerData } = require('node:worker_threads');

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) || null : null;
}

function getTrackNumber(value) {
  return Number.isInteger(value) && value > 0 && value <= 99999 ? value : null;
}

async function readMetadata() {
  try {
    const { parseFile } = await import('music-metadata');
    const metadata = await parseFile(workerData.filePath, {
      duration: false,
      skipCovers: true
    });
    const common = metadata?.common || {};

    parentPort.postMessage({
      success: true,
      data: {
        artist: cleanText(common.artist) || cleanText(common.albumArtist),
        title: cleanText(common.title),
        album: cleanText(common.album),
        trackNumber: getTrackNumber(common.track?.no)
      }
    });
  } catch (error) {
    parentPort.postMessage({
      success: false,
      error: error instanceof Error ? error.message : 'Не удалось прочитать метаданные'
    });
  }
}

readMetadata();
