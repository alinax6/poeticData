const { Engine, Bodies, Body, Composite, Query } = Matter;

const IMAGE_FOLDER = "images/";

// Load data.json
let siteData;
try {
  const response = await fetch("data.json");
  siteData = await response.json();
} catch (error) {
  // Fails when opened by double-click, so explain the fix
  document.body.insertAdjacentHTML("afterbegin",
    `<p style="background:#fff3cd;padding:12px 16px;margin:0;font-family:'Work Sans',sans-serif;">
      Couldn't load data.json. Open this page through a local server
      (for example VS Code's Live Server) or from GitHub Pages instead of double-clicking the file.
    </p>`);
  throw error;
}

const {
  regionData,
  regionOrder,
  regionShortNames,
  regionHints,
  itemGroups,
  itemImages,
  allImageFiles,
  guessChoices,
  groupColors,
  groupLabels,
  materialShares,
  journeyStages
} = siteData;

// helpers

// null = loading or missing
const loadedImages = {};

function loadImage(fileName) {
  if (!fileName || fileName in loadedImages) return;
  loadedImages[fileName] = null;
  const picture = new Image();
  picture.onload = () => { loadedImages[fileName] = picture; };
  picture.src = IMAGE_FOLDER + fileName;
}

allImageFiles.forEach(loadImage);

function friendlyNameFromFile(fileName) {
  // White versions share the name
  const withoutExtension = fileName.replace(".png", "").replace(/White$/, "");
  const withSpaces = withoutExtension.replace(/([A-Z])/g, " $1").toLowerCase();
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

function shortLabel(itemName) {
  return itemName.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
}

function formatPercent(number) {
  return (Math.round(number * 10) / 10).toFixed(1) + "%";
}

function debounce(callback, waitMs) {
  let timerId;
  return (...args) => {
    clearTimeout(timerId);
    timerId = setTimeout(() => callback(...args), waitMs);
  };
}

function getTopItems(regionName) {
  const itemsAndShares = Object.entries(regionData[regionName]);
  return itemsAndShares
    .map(([name, share]) => ({ name, share, group: itemGroups[name] }))
    .sort((itemA, itemB) => itemB.share - itemA.share);
}

function getGroupTotals(regionName) {
  const totals = { takeout: 0, fishing: 0, other: 0 };
  getTopItems(regionName).forEach(item => { totals[item.group] += item.share; });
  return totals;
}

function groupSummaryText(regionName) {
  const totals = getGroupTotals(regionName);
  return ["takeout", "fishing", "other"]
    .map(group => `${groupLabels[group]} ${formatPercent(totals[group])}`)
    .join(" · ");
}

function makeIconImage(fileName, altText) {
  const picture = document.createElement("img");
  picture.src = IMAGE_FOLDER + fileName;
  picture.alt = altText;
  picture.onerror = () => {
    const circle = document.createElement("span");
    circle.className = picture.className || "icon-fallback";
    Object.assign(circle.dataset, picture.dataset);
    circle.style.cssText = picture.style.cssText;
    circle.textContent = shortLabel(friendlyNameFromFile(fileName));
    circle.title = friendlyNameFromFile(fileName);
    picture.replaceWith(circle);
  };
  return picture;
}

let sketchSwatchCount = 0;   // unique clip-path ids
function makeSketchSwatch(color) {
  const size = 18;
  const center = size / 2;
  const radius = 6.6;
  const clipId = `swatch-clip-${sketchSwatchCount++}`;

  const hatchStrokes = [];
  for (let x = -4; x < size; x += 2.4) {
    hatchStrokes.push(`M${(x + randomBetween(-0.4, 0.4)).toFixed(1)},${size - 1} L${(x + 7 + randomBetween(-0.5, 0.5)).toFixed(1)},1`);
  }

  // turns so the ends overlap
  const outlinePoints = [];
  const startAngle = randomBetween(0, Math.PI * 2);
  const wobblePhase = randomBetween(0, Math.PI * 2);
  const steps = 40;
  for (let step = 0; step <= steps; step++) {
    const angle = startAngle + (step / steps) * Math.PI * 2 * 1.15;
    const wobblyRadius = radius + 0.5 * Math.sin(angle * 2 + wobblePhase) + step * 0.012;
    outlinePoints.push(`${(center + Math.cos(angle) * wobblyRadius).toFixed(1)},${(center + Math.sin(angle) * wobblyRadius).toFixed(1)}`);
  }

  return `
    <svg class="sketch-swatch" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <clipPath id="${clipId}"><circle cx="${center}" cy="${center}" r="${radius}" /></clipPath>
      <path class="swatch-hatch" d="${hatchStrokes.join(" ")}" stroke="${color}" clip-path="url(#${clipId})" />
      <polyline class="swatch-outline" points="${outlinePoints.join(" ")}" />
    </svg>`;
}

function buildLegend(legendElement, groups, onHover) {
  legendElement.innerHTML = "";
  groups.forEach(group => {
    const legendItem = document.createElement("span");
    legendItem.className = "legend-item";
    legendItem.innerHTML = `${makeSketchSwatch(groupColors[group])}${groupLabels[group]}`;
    if (onHover) {
      legendItem.addEventListener("mouseenter", () => onHover(group));
      legendItem.addEventListener("mouseleave", () => onHover(null));
    }
    legendElement.appendChild(legendItem);
  });
}

//TrashPile (Matter.js physics, drawing)
class TrashPile {
  constructor(boxElement) {
    this.box = boxElement;
    this.canvas = boxElement.querySelector("canvas");
    this.context = this.canvas.getContext("2d");
    this.tooltip = boxElement.querySelector(".tooltip");

    this.engine = Engine.create();
    this.walls = [];
    this.bodies = [];
    this.dropTimers = [];
    this.highlightGroup = null;  // "takeout", "fishing", "other" or null
    this.currentRegion = null;
    this.isOnScreen = true;
    this.showLabels = true;

    this.measureAndBuildWalls();
    this.listenForResize();
    this.listenForHover();
    this.pauseWhenOffScreen();

    this.lastFrameTime = performance.now();
    requestAnimationFrame(time => this.animate(time));
  }

  measureAndBuildWalls() {
    const boxSize = this.box.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    this.width = boxSize.width;
    this.height = boxSize.height;

    this.canvas.width = this.width * pixelRatio;
    this.canvas.height = this.height * pixelRatio;
    this.canvas.style.width = this.width + "px";
    this.canvas.style.height = this.height + "px";
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    Composite.remove(this.engine.world, this.walls);
    const wallThickness = 400;
    const floor = Bodies.rectangle(this.width / 2, this.height + wallThickness / 2, this.width * 4, wallThickness, { isStatic: true });
    const leftWall = Bodies.rectangle(-wallThickness / 2, 0, wallThickness, this.height * 6, { isStatic: true });
    const rightWall = Bodies.rectangle(this.width + wallThickness / 2, 0, wallThickness, this.height * 6, { isStatic: true });
    this.walls = [floor, leftWall, rightWall];
    Composite.add(this.engine.world, this.walls);
  }

  listenForResize() {
    let previousWidth = this.width;
    const remeasure = debounce(() => {
      this.measureAndBuildWalls();
      // Width only: phones change height while scrolling
      if (Math.abs(this.width - previousWidth) > 20 && this.currentRegion) {
        this.dropRegion(this.currentRegion, { quick: true });
      }
      previousWidth = this.width;
    }, 150);
    new ResizeObserver(remeasure).observe(this.box);
  }

  pauseWhenOffScreen() {
    const watcher = new IntersectionObserver(entries => {
      this.isOnScreen = entries[0].isIntersecting;
    });
    watcher.observe(this.box);
  }

  clear() {
    this.dropTimers.forEach(clearTimeout);
    this.dropTimers = [];
    Composite.remove(this.engine.world, this.bodies);
    this.bodies = [];
  }

  addPiece(piece, radius, x, y) {
    const body = Bodies.circle(x, y, radius, {
      restitution: 0.25,
      friction: 0.6,
      frictionAir: 0.012,
      density: 0.0015
    });
    Body.setAngle(body, Math.random() * Math.PI * 2);
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.08);
    body.piece = piece;
    body.radius = radius;
    this.bodies.push(body);
    Composite.add(this.engine.world, body);
  }

  // Each piece's area matches its share
  dropRegion(regionName, options = {}) {
    this.clear();
    this.currentRegion = regionName;
    const topItems = getTopItems(regionName);

    const totalShare = topItems.reduce((sum, item) => sum + item.share, 0);
    const areaPerPercent = (this.width * this.height * 0.4) / totalShare;
    let radii = topItems.map(item => Math.sqrt((item.share * areaPerPercent) / Math.PI));

    // Shrink all equally to keep proportions
    const largestAllowedRadius = Math.min(this.width, this.height) * 0.3;
    const largestRadius = Math.max(...radii);
    if (largestRadius > largestAllowedRadius) {
      const shrink = largestAllowedRadius / largestRadius;
      radii = radii.map(radius => radius * shrink);
    }

    const delayBetweenDrops = options.quick ? 40 : 260;
    topItems.forEach((item, index) => {
      const radius = radii[index];
      const piece = {
        name: item.name,
        share: item.share,
        group: item.group,
        imageFile: itemImages[item.name]
      };
      const timerId = setTimeout(() => {
        const x = radius + Math.random() * Math.max(1, this.width - radius * 2);
        this.addPiece(piece, radius, x, -radius - 10);
      }, index * delayBetweenDrops);
      this.dropTimers.push(timerId);
    });
  }

  setHighlight(groupName) {
    this.highlightGroup = groupName || null;
  }

  listenForHover() {
    this.canvas.addEventListener("mousemove", event => {
      const canvasBox = this.canvas.getBoundingClientRect();
      const mousePoint = { x: event.clientX - canvasBox.left, y: event.clientY - canvasBox.top };
      const piecesUnderMouse = Query.point(this.bodies, mousePoint);

      if (piecesUnderMouse.length === 0) {
        this.tooltip.hidden = true;
        this.canvas.style.cursor = "default";
        return;
      }

      const piece = piecesUnderMouse[0].piece;
      this.tooltip.innerHTML = piece.share
        ? `<strong>${piece.name}</strong>${formatPercent(piece.share)} of nearshore litter`
        : `<strong>${piece.name}</strong>`;
      this.tooltip.style.left = mousePoint.x + "px";
      this.tooltip.style.top = mousePoint.y + "px";
      this.tooltip.hidden = false;
      this.canvas.style.cursor = "pointer";
    });

    this.canvas.addEventListener("mouseleave", () => { this.tooltip.hidden = true; });
  }

  animate(time) {
    const elapsed = Math.min(time - this.lastFrameTime, 32); // cap big jumps
    this.lastFrameTime = time;
    if (this.isOnScreen) {
      Engine.update(this.engine, elapsed);
      this.draw();
    }
    requestAnimationFrame(nextTime => this.animate(nextTime));
  }

  draw() {
    const context = this.context;
    context.clearRect(0, 0, this.width, this.height);

    this.bodies.forEach(body => {
      const { piece, radius } = body;
      const isDimmed = this.highlightGroup && piece.group !== this.highlightGroup;
      const isHighlighted = this.highlightGroup && !isDimmed;

      context.save();
      context.translate(body.position.x, body.position.y);
      context.rotate(body.angle);
      context.globalAlpha = isDimmed ? 0.15 : 1;

      if (isHighlighted) {
        context.beginPath();
        context.arc(0, 0, radius, 0, Math.PI * 2);
        context.fillStyle = groupColors[piece.group] + "33"; // 20% opacity
        context.fill();
        context.lineWidth = 3;
        context.strokeStyle = groupColors[piece.group];
        context.stroke();
      }

      const picture = piece.imageFile ? loadedImages[piece.imageFile] : null;
      if (picture) {
        const scale = (radius * 2 * 1.05) / Math.max(picture.width, picture.height);
        const drawWidth = picture.width * scale;
        const drawHeight = picture.height * scale;
        context.drawImage(picture, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      } else {
        context.beginPath();
        context.arc(0, 0, radius, 0, Math.PI * 2);
        context.fillStyle = groupColors[piece.group] || groupColors.other;
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = "#1b1d22";
        context.stroke();
        if (radius > 14) {
          context.fillStyle = "#fff";
          context.font = `700 ${Math.max(10, radius * 0.4)}px Work Sans, sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(shortLabel(piece.name), 0, 0);
        }
      }
      context.restore();
    });

    // Tags drawn after, so they stay upright
    if (!this.showLabels) return;
    this.bodies.forEach(body => {
      const { piece, radius } = body;
      if (!piece.share || radius < 22) return;
      const isDimmed = this.highlightGroup && piece.group !== this.highlightGroup;
      const tagText = formatPercent(piece.share);

      context.save();
      context.globalAlpha = isDimmed ? 0.2 : 1;
      context.font = "700 12px Work Sans, sans-serif";
      const tagWidth = context.measureText(tagText).width + 12;
      const tagX = body.position.x - tagWidth / 2;
      const tagY = body.position.y + radius * 0.55;
      context.fillStyle = "#fff";
      context.strokeStyle = groupColors[piece.group];
      context.lineWidth = 2;
      context.beginPath();
      context.rect(tagX, tagY, tagWidth, 20);
      context.fill();
      context.stroke();
      context.fillStyle = "#1b1d22";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(tagText, body.position.x, tagY + 10);
      context.restore();
    });
  }
}

// hero pile
const heroPile = new TrashPile(document.getElementById("hero-pile-box"));
heroPile.showLabels = false;

function groupForImage(fileName) {
  const matchingItem = Object.keys(itemImages).find(name => itemImages[name] === fileName);
  if (matchingItem) return itemGroups[matchingItem];
  if (fileName === "cutlery.png") return "takeout";
  if (fileName === "line.png") return "fishing";
  return "other";
}

function dropRandomHeroPiece(x, y) {
  const fileName = allImageFiles[Math.floor(Math.random() * allImageFiles.length)];
  const piece = {
    name: friendlyNameFromFile(fileName),
    group: groupForImage(fileName),
    imageFile: fileName
  };
  const baseRadius = Math.min(heroPile.width, heroPile.height) * 0.045;
  const radius = baseRadius * (0.8 + Math.random() * 0.6);
  heroPile.addPiece(piece, radius, x ?? radius + Math.random() * (heroPile.width - radius * 2), y ?? -radius);

  if (heroPile.bodies.length > 110) {
    const oldestBody = heroPile.bodies.shift();
    Composite.remove(heroPile.engine.world, oldestBody);
  }
}

for (let pieceNumber = 0; pieceNumber < 55; pieceNumber++) {
  heroPile.dropTimers.push(setTimeout(() => dropRandomHeroPiece(), pieceNumber * 90));
}

heroPile.canvas.addEventListener("click", event => {
  const canvasBox = heroPile.canvas.getBoundingClientRect();
  const clickX = event.clientX - canvasBox.left;
  for (let extra = 0; extra < 3; extra++) {
    setTimeout(() => dropRandomHeroPiece(clickX + (Math.random() - 0.5) * 60, -30), extra * 120);
  }
});

//guess the coast
const regionChoicesBox = document.getElementById("region-choices");
const itemChoicesBox = document.getElementById("item-choices");
const itemStep = document.getElementById("item-step");
const gameResult = document.getElementById("game-result");
let chosenRegion = null;

regionOrder.forEach(regionName => {
  const button = document.createElement("button");
  button.className = "choice";
  button.innerHTML = `<span class="choice-name">${regionShortNames[regionName]}</span><span class="choice-hint">${regionHints[regionName]}</span>`;
  button.addEventListener("click", () => {
    chosenRegion = regionName;
    regionChoicesBox.querySelectorAll(".choice").forEach(other => other.classList.remove("is-selected"));
    button.classList.add("is-selected");
    itemStep.classList.remove("is-locked");
    resetItemChoices();
  });
  regionChoicesBox.appendChild(button);
});

guessChoices.forEach(choice => {
  const button = document.createElement("button");
  button.className = "choice item-choice";
  const iconRow = document.createElement("span");
  iconRow.className = "choice-icons";
  choice.images.forEach(fileName => iconRow.appendChild(makeIconImage(fileName, "")));
  const label = document.createElement("span");
  label.className = "choice-name";
  label.textContent = choice.label;
  button.append(iconRow, label);
  button.addEventListener("click", () => checkGuess(choice, button));
  choice.button = button;
  itemChoicesBox.appendChild(button);
});

function resetItemChoices() {
  guessChoices.forEach(choice => choice.button.classList.remove("is-correct", "is-wrong"));
  gameResult.hidden = true;
}

function checkGuess(guessedChoice, guessedButton) {
  resetItemChoices();
  const topItems = getTopItems(chosenRegion);
  const numberOneItem = topItems[0];
  const correctChoice = guessChoices.find(choice => choice.matches.includes(numberOneItem.name));
  const isRight = guessedChoice === correctChoice;

  correctChoice.button.classList.add("is-correct");
  if (!isRight) guessedButton.classList.add("is-wrong");

  const guessRank = topItems.findIndex(item => guessedChoice.matches.includes(item.name)) + 1;
  const guessShare = topItems
    .filter(item => guessedChoice.matches.includes(item.name))
    .reduce((sum, item) => sum + item.share, 0);

  const regionLabel = chosenRegion === "High income"
    ? "high-income coasts"
    : `the coasts of ${regionShortNames[chosenRegion]}`;
  let detail;
  if (isRight) {
    detail = `Off ${regionLabel}, ${correctChoice.label.toLowerCase()} make up ${formatPercent(numberOneItem.share)} of the litter.`;
  } else if (guessRank > 0) {
    detail = `Off ${regionLabel}, the #1 item is <strong>${correctChoice.label.toLowerCase()}</strong> at ${formatPercent(numberOneItem.share)}. Your guess ranks #${guessRank}, at ${formatPercent(guessShare)}.`;
  } else {
    detail = `Off ${regionLabel}, the #1 item is <strong>${correctChoice.label.toLowerCase()}</strong> at ${formatPercent(numberOneItem.share)}. Your guess isn't even in the top 10.`;
  }

  gameResult.innerHTML = `
    <p class="big">${isRight ? "You got it!" : "Not quite."}</p>
    <p>${detail}</p>`;
  gameResult.hidden = false;
}

// Waffle (1 square = 1%)
const waffleBox = document.getElementById("waffle");
const waffleCaption = document.getElementById("waffle-caption");
const waffleLegend = document.getElementById("waffle-legend");
const waffleCells = [];

const cellMaterials = [];
materialShares.forEach(material => {
  for (let count = 0; count < material.share; count++) cellMaterials.push(material);
});

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function makeScribblePoints() {
  const points = [];
  const strokeCount = 7;
  const firstY = 16;
  const lastY = 90;
  const stepBetweenStrokes = (lastY - firstY) / strokeCount;
  const slant = 18;

  for (let strokeNumber = 0; strokeNumber <= strokeCount; strokeNumber++) {
    const baseY = firstY + strokeNumber * stepBetweenStrokes;
    const leftX = randomBetween(6, 14);
    const rightX = randomBetween(86, 95);
    points.push(`${leftX.toFixed(1)},${(baseY + slant / 2 + randomBetween(-2, 2)).toFixed(1)}`);
    points.push(`${rightX.toFixed(1)},${(baseY - slant / 2 + randomBetween(-2, 2)).toFixed(1)}`);
  }
  return points.join(" ");
}

// Rough-ink filter used by the scribbles
document.body.insertAdjacentHTML("beforeend", `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <filter id="marker-rough">
      <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="4" />
      <feDisplacementMap in="SourceGraphic" scale="5" />
    </filter>
  </svg>`);

cellMaterials.forEach((material, index) => {
  const cell = document.createElement("div");
  cell.className = "waffle-cell";
  cell.style.setProperty("--delay", `${index * 8}ms`);

  const tiltDegrees = randomBetween(-6, 6).toFixed(1);
  cell.innerHTML = `
    <svg viewBox="0 0 100 100" aria-hidden="true" style="transform: rotate(${tiltDegrees}deg)">
      <polyline points="${makeScribblePoints()}" />
    </svg>`;

  waffleBox.appendChild(cell);
  waffleCells.push(cell);
});

function showWaffle(stateName) {
  waffleLegend.innerHTML = "";

  waffleCells.forEach((cell, index) => {
    const material = cellMaterials[index];
    cell.classList.remove("is-faded");

    if (stateName === "materials") {
      cell.style.color = material.color;
    } else if (stateName === "takeout") {
      // 44% takeout
      cell.style.color = index < 44 ? groupColors.takeout : material.color;
      if (index >= 44) cell.classList.add("is-faded");
    } else if (stateName === "topten") {
      // 75% top 10
      cell.style.color = index < 75 ? "#1b1d22" : material.color;
      if (index >= 75) cell.classList.add("is-faded");
    }
  });

  const legendEntries = {
    materials: materialShares.map(material => [material.color, `${material.name} ${material.share}%`]),
    takeout: [[groupColors.takeout, "Bags, bottles, food containers & wrappers 44%"]],
    topten: [["#1b1d22", "Top 10 item types ≈ 75%"]]
  };
  const captions = {
    materials: "By material",
    takeout: "Four takeout items",
    topten: "10 of 112 item types"
  };
  waffleCaption.textContent = captions[stateName];
  legendEntries[stateName].forEach(([color, text]) => {
    const legendItem = document.createElement("span");
    legendItem.className = "legend-item";
    legendItem.innerHTML = `${makeSketchSwatch(color)}${text}`;
    waffleLegend.appendChild(legendItem);
  });
}

showWaffle("materials");

// Scrolly pile 
const scrollyPile = new TrashPile(document.getElementById("scrolly-pile-box"));
const scrollyTitle = document.getElementById("scrolly-title");
const scrollyStats = document.getElementById("scrolly-stats");
buildLegend(document.getElementById("scrolly-legend"), ["takeout", "fishing", "other"], group => scrollyPile.setHighlight(group));

function showScrollyStep(stepElement) {
  const regionName = stepElement.dataset.region;
  if (regionName !== scrollyPile.currentRegion) {
    scrollyPile.dropRegion(regionName);
    scrollyTitle.textContent = `${regionShortNames[regionName]}: top 10 items`;
    scrollyStats.textContent = groupSummaryText(regionName);
  }
  scrollyPile.setHighlight(stepElement.dataset.highlight);
}

// Explorer
const explorePile = new TrashPile(document.getElementById("explore-pile-box"));
const exploreTabs = document.getElementById("explore-tabs");
const exploreRegionLabel = document.getElementById("explore-region");
const exploreList = document.getElementById("explore-list");
buildLegend(document.getElementById("explore-legend"), ["takeout", "fishing", "other"], group => explorePile.setHighlight(group));

function showExploreRegion(regionName) {
  explorePile.dropRegion(regionName);
  exploreRegionLabel.textContent = regionShortNames[regionName];

  exploreTabs.querySelectorAll(".tab").forEach(tab => {
    const isActive = tab.dataset.region === regionName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  const topItems = getTopItems(regionName);
  const biggestShare = topItems[0].share;
  exploreList.innerHTML = topItems.map(item => `
    <li>
      <span class="bar-row">
        ${item.name}
        ${makeSketchBar(Math.max(10, (item.share / biggestShare) * 80), 14, groupColors[item.group])}
        ${formatPercent(item.share)}
      </span>
    </li>`).join("");
}

regionOrder.forEach(regionName => {
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.setAttribute("role", "tab");
  tab.dataset.region = regionName;
  tab.textContent = regionShortNames[regionName];
  tab.addEventListener("click", () => showExploreRegion(regionName));
  exploreTabs.appendChild(tab);
});

document.getElementById("explore-redrop").addEventListener("click", () => {
  showExploreRegion(explorePile.currentRegion || regionOrder[0]);
});

// Out to sea
const seaScene = document.getElementById("sea-scene");
const seaItemsBox = document.getElementById("sea-items");
const depthGauge = document.getElementById("depth-gauge");
const journeyStepsBox = document.getElementById("journey-steps");
const lastStageIndex = journeyStages.length - 1;

journeyStages.forEach((stage, stageIndex) => {
  const gaugeStop = document.createElement("span");
  gaugeStop.className = "gauge-stop";
  gaugeStop.textContent = stage.name;
  depthGauge.appendChild(gaugeStop);

  const stepCard = document.createElement("div");
  stepCard.className = "step journey-step";
  stepCard.dataset.stage = stageIndex;
  stepCard.innerHTML = `${stageIndex === 0 ? '<h2 class="step-heading">Out to sea</h2>' : ""}<h3>${stage.name}</h3><p>${stage.fact}</p>`;
  journeyStepsBox.appendChild(stepCard);

  stage.items.forEach((item, itemIndex) => {
    const picture = makeIconImage(item.image, friendlyNameFromFile(item.image));
    picture.classList.add("sea-item");
    picture.dataset.stage = stageIndex;
    picture.style.left = item.x + "%";
    picture.style.top = item.y + "%";
    picture.style.setProperty("--tilt", `${(Math.random() - 0.5) * 50}deg`);
    picture.style.setProperty("--delay", `${itemIndex * 0.12}s`);
    if (stageIndex === lastStageIndex) picture.classList.add("is-sunk");
    seaItemsBox.appendChild(picture);
  });
});

function showJourneyStage(stageIndex) {
  const stage = journeyStages[stageIndex];

  // Colors live in style.css
  seaScene.dataset.stage = stageIndex;
  // Under 0.5 = light water (River to Nearshore)
  seaScene.classList.toggle("is-shallow", stage.depth < 0.5);

  depthGauge.querySelectorAll(".gauge-stop").forEach((stop, index) => {
    stop.classList.toggle("is-active", index === stageIndex);
  });

  seaItemsBox.querySelectorAll(".sea-item").forEach(element => {
    element.classList.toggle("is-visible", Number(element.dataset.stage) === stageIndex);
  });
}

showJourneyStage(0);

// Appendix
const appendixSelect = document.getElementById("appendix-select");
const appendixTableBody = document.querySelector("#appendix-table tbody");

regionOrder.forEach(regionName => {
  const option = document.createElement("option");
  option.value = regionName;
  option.textContent = regionName;
  appendixSelect.appendChild(option);
});

// Finer rough-ink filter for thin bars
document.body.insertAdjacentHTML("beforeend", `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <filter id="marker-rough-fine">
      <feTurbulence type="fractalNoise" baseFrequency="0.25" numOctaves="2" seed="7" />
      <feDisplacementMap in="SourceGraphic" scale="1.8" />
    </filter>
  </svg>`);

function makeSketchBar(barWidth, barHeight, color) {
  const strokeSlant = 7;
  const strokeLayers = [];

  const layerSettings = [
    { startX: 1, spacing: 3.6 },
    { startX: 2.5, spacing: 7.5 }
  ];

  layerSettings.forEach(({ startX, spacing }) => {
    const strokes = [];
    for (let x = startX; x < barWidth - strokeSlant; x += spacing) {
      const bottomX = x + randomBetween(-0.6, 0.6);
      const bottomY = barHeight - randomBetween(1, 2.5);
      const topX = x + strokeSlant + randomBetween(-1, 1);
      const topY = randomBetween(1, 2.5);
      strokes.push(`M${bottomX.toFixed(1)},${bottomY.toFixed(1)} L${topX.toFixed(1)},${topY.toFixed(1)}`);
    }
    strokeLayers.push(`<path d="${strokes.join(" ")}" />`);
  });

  return `
    <svg class="sketch-bar" width="${barWidth.toFixed(1)}" height="${barHeight}"
         viewBox="0 0 ${barWidth.toFixed(1)} ${barHeight}" style="color:${color}" aria-hidden="true">
      ${strokeLayers.join("")}
    </svg>`;
}

function showAppendixRegion(regionName) {
  const topItems = getTopItems(regionName);
  const biggestShare = topItems[0].share;
  appendixTableBody.innerHTML = topItems.map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${item.name}</td>
      <td><span class="group-tag" style="background:${groupColors[item.group]}">${groupLabels[item.group]}</span></td>
      <td><span class="share-cell">
        ${makeSketchBar(Math.max(12, (item.share / biggestShare) * 180), 20, groupColors[item.group])}
        ${formatPercent(item.share)}
      </span></td>
    </tr>`).join("");
}

appendixSelect.addEventListener("change", () => showAppendixRegion(appendixSelect.value));
showAppendixRegion(regionOrder[0]);

// Scroll watchers (steps activate at mid-screen)
function watchSteps(stepElements, onStepActivate, activationLine = "-50% 0px -50% 0px") {
  const watcher = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      stepElements.forEach(step => step.classList.toggle("is-active", step === entry.target));
      onStepActivate(entry.target);
    });
  }, { rootMargin: activationLine });
  stepElements.forEach(step => watcher.observe(step));
}

watchSteps([...document.querySelectorAll("#global .step")], step => showWaffle(step.dataset.waffle));

const scrollySteps = [...document.querySelectorAll("#scrolly .step")];
watchSteps(scrollySteps, showScrollyStep);

// Drop a pile on arrival so it isn't empty
const scrollyStartWatcher = new IntersectionObserver(entries => {
  if (!entries[0].isIntersecting) return;
  if (!scrollyPile.currentRegion) showScrollyStep(scrollySteps[0]);
  scrollyStartWatcher.disconnect();
}, { threshold: 0.2 });
scrollyStartWatcher.observe(document.getElementById("scrolly-pile-box"));

// On phones the sea sits in the top half, so stages switch at 70% down instead of the middle
const journeyLine = window.matchMedia("(max-width: 860px)").matches ? "-70% 0px -30% 0px" : "-50% 0px -50% 0px";
watchSteps([...document.querySelectorAll(".journey-step")], step => showJourneyStage(Number(step.dataset.stage)), journeyLine);

const explorerWatcher = new IntersectionObserver(entries => {
  if (!entries[0].isIntersecting) return;
  showExploreRegion(regionOrder[0]);
  explorerWatcher.disconnect();
}, { threshold: 0.3 });
explorerWatcher.observe(document.getElementById("explore-pile-box"));

const revealWatcher = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add("is-visible");
  });
}, { threshold: 0.15 });
document.querySelectorAll(".reveal").forEach(element => revealWatcher.observe(element));