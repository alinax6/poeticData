

/* image and audio files */

// Builds a list of image and audio files
function numberedPaths(folder, baseName, count, extension) {
  const paths = [];
  for (let number = 1; number <= count; number++) {
    paths.push(`${folder}/${baseName}${number}.${extension}`);
  }
  return paths;
}

const bigDoorImagePaths = numberedPaths("images", "bigDoor", 13, "png");
const smallDoorImagePaths = numberedPaths("images", "smallDoor", 15, "png");
const doorSoundPaths = numberedPaths("sound", "door", 9, "mp3");
const footstepSoundPaths = numberedPaths("sound", "footstep", 5, "mp3");


/* settings */

const PIXELS_PER_SECOND = 160;        // how far the room scrolls per second of sound
const LEFT_PADDING = 90;              // empty space before the first door
const GAP_BETWEEN_SOUNDS = 0.5;       // seconds of silence between recordings

const QUIETEST_DB = -50;              // this loudness (or quieter) counts as 0
const LOUDEST_DB = 0;                 // this loudness counts as 1

const JUMP_RATIO = 1.6;               // a new sound must be 1.6x louder than the recent average
const MIN_SECONDS_BETWEEN_DOORS = 0.11;
const GROW_SECONDS = 0.16;            // a new door keeps growing while its sound peaks

// Door heights, as a share of the wall height
const BIG_DOOR_SMALLEST = 0.55;       // quietest door sound → 35% of the wall
const BIG_DOOR_TALLEST = 1;        // loudest door sound → 80% of the wall
const SMALL_DOOR_SMALLEST = 0.45;     // quietest footstep → 12% of the wall
const SMALL_DOOR_TALLEST = 0.9;      // loudest footstep → 45% of the wall

const MAX_IMAGE_HEIGHT = 1000;        // big photos are shrunk to this height once, at load, so swinging stays smooth


/* page elements */

const stage = document.getElementById("stage");
const track = document.getElementById("track");
const doorsLayer = document.getElementById("doorsLayer");
const playhead = document.getElementById("playhead");
const emptyMessage = document.getElementById("emptyMessage");
const playButton = document.getElementById("playButton");
const sensitivitySlider = document.getElementById("sensitivitySlider");
const statusText = document.getElementById("statusText");
const wallText = document.querySelector(".wall-text");
const WALL_TEXT_SECONDS = 15;
let hideWallTextTimer = null;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");


const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const analyser = audioContext.createAnalyser();
analyser.fftSize = 1024;              // how many samples we look at each frame
analyser.smoothingTimeConstant = 0;
analyser.connect(audioContext.destination);

const waveformSamples = new Float32Array(analyser.fftSize);
const frequencyLevels = new Float32Array(analyser.frequencyBinCount);

let bigDoorImages = [];               // { path, aspectRatio }
let smallDoorImages = [];
let playlist = [];                    // { name, kind: "door" or "footstep", buffer }

let nextBigImage = 0;
let nextSmallImage = 0;

let isPlaying = false;
let stopRequested = false;
let currentSource = null;
let nowPlaying = null;                // { sound, startedAt, timelineStart }
let timelineSeconds = 0;              // where the next recording begins on the timeline

let stageWidth = stage.clientWidth;   // remembered so we don't re-measure the page every frame
let trackWidth = stageWidth;
let cameraOffset = 0;                 // how far the room has slid left to follow the playhead
let lastXPosition = 0;
window.addEventListener("resize", () => { stageWidth = stage.clientWidth; });

let recentAverageLoudness = 0;
let lastDoorTime = -1;
let growingDoor = null;
let doorCount = 0;

const doorDetails = new WeakMap();    // door element info for replaying it


/* load files */

async function loadImage(path) {
  try {
    const image = new Image();
    image.src = path;
    await image.decode();
    const aspectRatio = image.naturalWidth / image.naturalHeight;
    const smallerPath = await shrinkImage(image);
    return { path: smallerPath, aspectRatio };
  } catch (error) {
    console.warn("Couldn't load image:", path);
    return null;
  }
}

// draw a smaller copy once of images
async function shrinkImage(image) {
  if (image.naturalHeight <= MAX_IMAGE_HEIGHT) return image.src;

  const scale = MAX_IMAGE_HEIGHT / image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = MAX_IMAGE_HEIGHT;
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

  const smallerFile = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return smallerFile ? URL.createObjectURL(smallerFile) : image.src;
}

async function loadSound(path, kind) {
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(response.status);
    const fileData = await response.arrayBuffer();
    const buffer = await audioContext.decodeAudioData(fileData);
    const name = path.split("/").pop().replace(".mp3", "");
    return { name, kind, buffer };
  } catch (error) {
    console.warn("Couldn't load sound:", path);
    return null;
  }
}

// Order the sounds to sound like a walk
function buildWalkingOrder(footsteps, doors) {
  const order = [];
  let footstepIndex = 0;
  let doorIndex = 0;
  while (footstepIndex < footsteps.length || doorIndex < doors.length) {
    if (footstepIndex < footsteps.length) order.push(footsteps[footstepIndex++]);
    if (doorIndex < doors.length) order.push(doors[doorIndex++]);
    if (doorIndex < doors.length) order.push(doors[doorIndex++]);
  }
  return order;
}

async function loadEverything() {
  const [bigImages, smallImages, doorSounds, footstepSounds] = await Promise.all([
    Promise.all(bigDoorImagePaths.map(loadImage)),
    Promise.all(smallDoorImagePaths.map(loadImage)),
    Promise.all(doorSoundPaths.map((path) => loadSound(path, "door"))),
    Promise.all(footstepSoundPaths.map((path) => loadSound(path, "footstep"))),
  ]);

  // drop anything that failed to load
  bigDoorImages = bigImages.filter(Boolean);
  smallDoorImages = smallImages.filter(Boolean);
  const loadedDoorSounds = doorSounds.filter(Boolean);
  const loadedFootstepSounds = footstepSounds.filter(Boolean);
  playlist = buildWalkingOrder(loadedFootstepSounds, loadedDoorSounds);

  if (playlist.length === 0) {
    emptyMessage.textContent = "No sounds loaded. Open this page through a local server, and check that the sound folder is next to index.html.";
    playButton.textContent = "Play";
    return;
  }

  const imageCount = bigDoorImages.length + smallDoorImages.length;
  emptyMessage.textContent = "Press play to walk through the doors.";
  statusText.textContent = `${playlist.length} recordings and ${imageCount} door images ready.`;
  playButton.textContent = "Play";
  playButton.disabled = false;
}


/* measure sound */

// Root mean square. Square every sample, average them, take the square root. This is converted to decibels
// and measured on a 0-1 scale. -50 db or less: 0, 0db: 1.
function measureLoudness() {
  analyser.getFloatTimeDomainData(waveformSamples);
  let sumOfSquares = 0;
  for (const sample of waveformSamples) sumOfSquares += sample * sample;
  const rootMeanSquare = Math.sqrt(sumOfSquares / waveformSamples.length);
  const decibels = 20 * Math.log10(rootMeanSquare + 1e-9); // for tiny number avoids log(0)
  return { rootMeanSquare, decibels };
}

// Use spectral centroid, the "center of gravity" of the sound frequencies.
// Thuds have low freq and creaks/clicks have high freq. ~150hz is mapped to 0 and ~4000hz is mapped to 1.
function measureBrightness() {
  analyser.getFloatFrequencyData(frequencyLevels);
  const hzPerBin = audioContext.sampleRate / analyser.fftSize;
  let weightedTotal = 0;
  let magnitudeTotal = 0;
  for (let bin = 1; bin < frequencyLevels.length; bin++) {
    const magnitude = Math.pow(10, frequencyLevels[bin] / 20);
    weightedTotal += bin * hzPerBin * magnitude;
    magnitudeTotal += magnitude;
  }
  const centroidHz = magnitudeTotal > 0 ? weightedTotal / magnitudeTotal : 200;
  // on a log scale based on how we hear pitch
  return clamp((Math.log2(centroidHz) - Math.log2(150)) / (Math.log2(4000) - Math.log2(150)), 0, 1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// The slider sets how loud a sound must be to place a door. -20 dB (fewer) to -60 dB (more)
// fewer doors (0): -20db. only loud sounds count 
// default (55): threshold = -20 - 0.55 * 40 = -42db
// more doors (100): -60db. quiet sounds and loud sounds count.
function spawnThresholdDb() {
  return -20 - (sensitivitySlider.value / 100) * 40;
}


/* main loop. runs about 60 times per second */

function everyFrame() {
  requestAnimationFrame(everyFrame);
  if (!nowPlaying) return;

  const { sound, startedAt, timelineStart } = nowPlaying;
  const timeInSound = audioContext.currentTime - startedAt;
  if (timeInSound < 0) return;

  // how many seconds into the whole piece we are
  const timelineTime = timelineStart + timeInSound;
  // pos is 90 + secs * 160. every sec of sound covers 160px of wall
  const xPosition = LEFT_PADDING + timelineTime * PIXELS_PER_SECOND;

  // move the playhead and slide the room with transforms
  lastXPosition = xPosition;
  playhead.style.transform = `translateX(${xPosition}px)`;

  // widen the room in big chunks, so it only happens once in a while
  if (xPosition + stageWidth > trackWidth) {
    trackWidth += 2000;
    track.style.width = trackWidth + "px";
  }

  // roome slides left once playhead passes 65% of the screen width
  const followPoint = stageWidth * 0.65;
  if (xPosition > followPoint) {
    cameraOffset = xPosition - followPoint;
    track.style.transform = `translateX(${-cameraOffset}px)`;
  }

  // measure loudness of this frame
  const { rootMeanSquare, decibels } = measureLoudness();
  const loudness = clamp((decibels - QUIETEST_DB) / (LOUDEST_DB - QUIETEST_DB), 0, 1);

  // a door that just appeared keeps growing until its sound peaks
  if (growingDoor) {
    if (timelineTime <= growingDoor.growUntil) {
      growingDoor.peakLoudness = Math.max(growingDoor.peakLoudness, loudness);
      growingDoor.brightnessTotal += measureBrightness();
      growingDoor.brightnessReadings += 1;
      sizeDoor(growingDoor.element, growingDoor.peakLoudness, growingDoor.size, growingDoor.aspectRatio);
    } else {
      finishDoor(growingDoor);
    }
  }

  // checks if a new door appear based on 3 conditions

  // curr loudness is more than 1.6x the recent average
  const isSuddenJump = rootMeanSquare > recentAverageLoudness * JUMP_RATIO;
  // loudness above the threshold set by the slider
  const isLoudEnough = decibels > spawnThresholdDb();
  // at least 0.11 secs since the last door
  const isSpacedOut = timelineTime - lastDoorTime > MIN_SECONDS_BETWEEN_DOORS;

  if (isSuddenJump && isLoudEnough && isSpacedOut) {
    if (growingDoor) finishDoor(growingDoor);
    placeDoor(xPosition, loudness, sound, timeInSound, timelineTime);
    lastDoorTime = timelineTime;
  }

  // the average drifts 4% toward the current loudness each frame
  recentAverageLoudness += (rootMeanSquare - recentAverageLoudness) * 0.04;
}
requestAnimationFrame(everyFrame);


/* doors */

// picks big/small door based on recording type and cycles through the images
function pickImage(size) {
  if (size === "big" && bigDoorImages.length) {
    return bigDoorImages[nextBigImage++ % bigDoorImages.length];
  }
  if (size === "small" && smallDoorImages.length) {
    return smallDoorImages[nextSmallImage++ % smallDoorImages.length];
  }
  return null;
}

function placeDoor(xPosition, loudness, sound, timeInSound, timelineTime) {
  const size = sound.kind === "door" ? "big" : "small";
  const imageInfo = pickImage(size);
  const aspectRatio = imageInfo ? imageInfo.aspectRatio : 0.46; // 0.46 = classic door shape

  // creates button with the door image inside
  const door = document.createElement("button");
  door.type = "button";
  door.className = `door door--${size}`;
  door.style.left = xPosition + "px";
  doorCount += 1;
  // statusText.textContent = `Playing ${sound.name}. ${doorCount} doors so far.`;
  statusText.textContent = `${doorCount} doors so far.`;
  door.setAttribute("aria-label", `Door ${doorCount}. Replay its sound.`);

  // big doors have light behind them, revealed when they swing open
  if (size === "big") {
    const light = document.createElement("span");
    light.className = "door__light";
    door.appendChild(light);
  }

  if (imageInfo) {
    const image = document.createElement("img");
    image.className = "door__image";
    image.src = imageInfo.path;
    image.alt = "";
    door.appendChild(image);
  } else {
    door.classList.add("door--plain");
  }

  const brightness = measureBrightness();
  setLightColor(door, brightness);
  sizeDoor(door, loudness, size, aspectRatio);
  doorsLayer.appendChild(door);
  emptyMessage.hidden = true;

  doorDetails.set(door, { buffer: sound.buffer, timeInSound, size, openAngle: 0 });
  door.addEventListener("click", () => replayDoor(door));

  growingDoor = {
    element: door,
    size,
    aspectRatio,
    peakLoudness: loudness,
    brightnessTotal: brightness,
    brightnessReadings: 1,
    growUntil: timelineTime + GROW_SECONDS,
  };
}

// Height comes from loudness. width keeps the photo's own proportions
function sizeDoor(door, loudness, size, aspectRatio) {
  const wallHeight = doorsLayer.clientHeight;
  const smallest = size === "big" ? BIG_DOOR_SMALLEST : SMALL_DOOR_SMALLEST;
  const tallest = size === "big" ? BIG_DOOR_TALLEST : SMALL_DOOR_TALLEST;

  const height = wallHeight * (smallest + (tallest - smallest) * loudness);
  const width = height * aspectRatio;

  door.style.height = height + "px";
  door.style.width = width + "px";
  door.style.setProperty("--door-height", height + "px");
}

// Once the sound has peaked, big doors swing open
function finishDoor(doorToFinish) {
  const door = doorToFinish.element;
  const averageBrightness = doorToFinish.brightnessTotal / doorToFinish.brightnessReadings;
  setLightColor(door, averageBrightness);

  if (doorToFinish.size === "big") {
    const loudness = doorToFinish.peakLoudness;
    const openAngle = 30 + 55 * loudness;          // louder: wider (30-85 deg)
    const swingTime = 2200 - 600 * loudness;       // louder: faster (2200ms to 1600ms)
    doorDetails.get(door).openAngle = openAngle;
    swingDoor(door, openAngle, swingTime);
  }
  growingDoor = null;
}

function swingDoor(door, angle, milliseconds) {
  door.style.setProperty("--swing", (prefersReducedMotion.matches ? 0 : milliseconds) + "ms");
  door.style.setProperty("--angle", angle);
  door.classList.toggle("is-open", angle > 1);
}

// Dull sounds have dimmer light. bright sounds brighter light
function setLightColor(door, brightness) {
  const dullLight = [184, 104, 44];
  const brightLight = [255, 240, 196];
  const mixed = dullLight.map((channel, i) => Math.round(channel + (brightLight[i] - channel) * brightness));
  door.style.setProperty("--light", `rgb(${mixed.join(",")})`);
  door.style.setProperty("--light-glow", `rgba(${mixed.join(",")}, 0.55)`);
}

// Clicking a door replays the moment of sound that made it
function replayDoor(door) {
  const details = doorDetails.get(door);
  if (!details) return;
  audioContext.resume();

  const replay = audioContext.createBufferSource();
  replay.buffer = details.buffer;
  replay.connect(audioContext.destination);   // skips the analyser, so replays don't place new doors
  replay.start(0, Math.max(0, details.timeInSound - 0.03), 0.8);

  if (prefersReducedMotion.matches) return;
  if (details.size === "big") {
    swingDoor(door, 0, 120);
    setTimeout(() => swingDoor(door, details.openAngle, 900), 140);
  } else {
    door.animate(
      [{ transform: "translateY(0)" }, { transform: "translateY(-8%)" }, { transform: "translateY(0)" }],
      { duration: 300 }
    );
  }
}


/* playback */

function playOneSound(sound) {
  return new Promise((resolve) => {
    const source = audioContext.createBufferSource();
    source.buffer = sound.buffer;
    source.connect(analyser);   // through the analyser, so the loop can hear it

    const startedAt = audioContext.currentTime + 0.05;
    nowPlaying = { sound, startedAt, timelineStart: timelineSeconds };
    currentSource = source;
    recentAverageLoudness = 0;
    // statusText.textContent = `Playing ${sound.name}. ${doorCount} doors so far.`;
    statusText.textContent = `${doorCount} doors so far.`;


    source.onended = () => {
      const secondsPlayed = Math.min(sound.buffer.duration, audioContext.currentTime - startedAt);
      timelineSeconds += Math.max(0, secondsPlayed) + GAP_BETWEEN_SOUNDS;
      nowPlaying = null;
      resolve();
    };
    source.start(startedAt);
  });
}

async function playEverything() {
  await audioContext.resume();
  clearRoom();

  // show the credit and key again, then hide them after 30 seconds
  wallText.classList.remove("is-quiet");
  clearTimeout(hideWallTextTimer);
  hideWallTextTimer = setTimeout(() => wallText.classList.add("is-quiet"), WALL_TEXT_SECONDS * 1000);
  isPlaying = true;
  stopRequested = false;
  playButton.textContent = "Stop";
  playhead.hidden = false;

  for (const sound of playlist) {
    if (stopRequested) break;
    await playOneSound(sound);
  }
  if (growingDoor) finishDoor(growingDoor);

  // switch from sliding back to normal scrolling, so you can scroll through the room
  trackWidth = Math.max(stageWidth, lastXPosition + stageWidth * 0.4);
  track.style.width = trackWidth + "px";
  track.style.transform = "";
  stage.scrollLeft = cameraOffset;

  isPlaying = false;
  playButton.textContent = "Play Again";
  playhead.hidden = true;
  statusText.textContent = `${doorCount} doors. Scroll back through the room or click any door to hear it.`;
}

function stopPlaying() {
  stopRequested = true;
  if (currentSource) {
    try { currentSource.stop(); } catch (error) { /* already stopped */ }
  }
}

function clearRoom() {
  doorsLayer.innerHTML = "";
  doorCount = 0;
  timelineSeconds = 0;
  lastDoorTime = -1;
  growingDoor = null;
  nextBigImage = 0;
  nextSmallImage = 0;
  track.style.width = "";
  track.style.transform = "";
  stage.scrollLeft = 0;
  stageWidth = stage.clientWidth;
  trackWidth = stageWidth;
  cameraOffset = 0;
  lastXPosition = 0;
}

playButton.addEventListener("click", () => {
  if (isPlaying) stopPlaying();
  else playEverything();
});


/* start and load */

loadEverything();