import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import * as yaml from 'js-yaml';
import concaveman from 'concaveman';

async function loadConfig(filename) {
    try {
        const response = await fetch(filename);
        const yml = await response.text();
        const config = yaml.load(yml);
        return config;
    } catch (e) {
        console.error(`Error reading config file "${filename}":`, e);
        return null;
    }
}

function parseLsystem(axiom, iterationCount, rules) {
    if (iterationCount === 0) return axiom;
    let newAxiom = "";
    for (const ch of axiom) {
        if (rules.has(ch)) {
            newAxiom += rules.get(ch);
        } else {
            newAxiom += ch;
        }
        if (newAxiom.length > 1e10) return axiom;
    }
    return parseLsystem(newAxiom, iterationCount - 1, rules);
}

// Also from https://www.geeksforgeeks.org/convex-hull-monotone-chain-algorithm/
function crossProduct(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// Pulled implementation for Andrew's algorithm/Monotone chain algorithm for finding convex hull of a set of points from https://www.geeksforgeeks.org/convex-hull-monotone-chain-algorithm/
function getConvexHull(points) {
    points = points.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
    const n = points.length;
    if (n <= 3) return points;

    let k = 0;
    let outline = new Array(2 * n);
    for (let i = 0; i < n; i++) {
        while (k >= 2 && crossProduct(outline[k - 2], outline[k - 1], points[i]) <= 0) {
            k--;
        }
        outline[k] = points[i];
        k++;
    }

    let i = n - 1;
    for (let t = k + 1; i > 0; i--) {
        while (k >= t && crossProduct(outline[k - 2], outline[k - 1], points[i - 1]) <= 0) {
            k--;
        }
        outline[k] = points[i - 1];
        k++;
    }

    outline.length = k - 1;

    return outline;
}

function getConcaveHull(points) {
    const pointsArr = points.map((pt) => [pt.x, pt.y]);
    const concaveHull = concaveman(pointsArr);
    return concaveHull.map((pt) => new THREE.Vector3(pt[0], pt[1], 0));
}

function drawLsystem(str, config) {
    let currentAngle = config.startAngle;
    let posX = 0;
    let posY = 0;
    const moveDistance = 1;

    let points = [new THREE.Vector3(posX, posY, 0)];
    let stack = [];

    for (const ch of str) {
        switch (ch) {
            case 'F':
                posX += Math.cos(THREE.MathUtils.degToRad(currentAngle)) * moveDistance;
                posY += Math.sin(THREE.MathUtils.degToRad(currentAngle)) * moveDistance;
                points.push(new THREE.Vector3(posX, posY, 0));
                break;
            case 'f':
                posX += Math.cos(THREE.MathUtils.degToRad(currentAngle)) * moveDistance;
                posY += Math.sin(THREE.MathUtils.degToRad(currentAngle)) * moveDistance;
                break;
            case '+':
                currentAngle += config.deltaAngle;
                break;
            case '-':
                currentAngle -= config.deltaAngle;
                break;
            case '[':
                stack.push([posX, posY, currentAngle]);
                break;
            case ']':
                if (stack.length === 0) break;
                const oldState = stack.pop();
                posX = oldState[0];
                posY = oldState[1];
                currentAngle = oldState[2];
                break;
            default:
        }
    }

    let outline = null;
    if (config.outlineType === "convexHull") {
        outline = getConvexHull(points);
    } else {
        outline = getConcaveHull(points);
    }

    const shape = new THREE.Shape();
    shape.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) {
        shape.lineTo(outline[i].x, outline[i].y);
    }
    shape.closePath();

    if (config.type === 'normal') {
        let extrudePoints = [];
        for (let i = 0; i < config.extrudePath.length; i++) {
            extrudePoints.push(new THREE.Vector3(...config.extrudePath[i]));
        }
        const extrudeCurve = new THREE.CatmullRomCurve3(extrudePoints);

        const geometry = new THREE.ExtrudeGeometry(shape, {
            ...config.extrudeConfig,
            extrudePath: extrudeCurve,
            steps: 100,
        });

        const material = new THREE.MeshPhongMaterial({color: config.color, side: THREE.DoubleSide});
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.set(config.scale, config.scale, config.scale);
        mesh.position.set(...config.position);
        mesh.rotation.set(THREE.MathUtils.degToRad(config.rotation[0]), THREE.MathUtils.degToRad(config.rotation[1]), THREE.MathUtils.degToRad(config.rotation[2]));
        return mesh;
    } else if (config.type === 'cone') {
        const coneGeometry = new THREE.BufferGeometry();
        const points = [];
        const basePoints = [];

        for (let i = 0; i < outline.length; i++) {
            basePoints.push(new THREE.Vector3(outline[i].x, outline[i].y, outline[i].z));
        }

        const n = basePoints.length;
        const tip = new THREE.Vector3(...config.tipPosition);

        const sphericalInterpolate = (base, tip, alpha) => {
            const theta = alpha * (Math.PI / 2);
            const cosTheta = Math.cos(theta);
            const sinTheta = Math.sin(theta);
            return [
                base.x * (1 - alpha) + tip.x * alpha,
                base.y * (1 - alpha) + tip.y * alpha,
                base.z * cosTheta + tip.z * sinTheta
            ];
        };

        for (let layer = 0; layer <= config.coneLayers; layer++) {
            for (let i = 0; i < n; i++) {
                points.push(...sphericalInterpolate(basePoints[i], tip, layer / config.coneLayers));
            }
        }

        let triangleIndexes = [];
        for (let layer = 0; layer < config.coneLayers; layer++) {
            const layerIndex = layer * n;
            const nextLayerIndex = (layer + 1) * n;
            for (let i = 0; i < n; i++) {
                const nextI = (i + 1) % n;
                triangleIndexes.push(layerIndex + i, layerIndex + nextI, nextLayerIndex + i);
                triangleIndexes.push(nextLayerIndex + i, layerIndex + nextI, nextLayerIndex + nextI);
            }
        }

        coneGeometry.setIndex(triangleIndexes);
        coneGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        coneGeometry.computeVertexNormals();

        const material = new THREE.MeshPhongMaterial({color: config.color, side: THREE.DoubleSide});
        const mesh = new THREE.Mesh(coneGeometry, material);
        mesh.scale.set(config.scale, config.scale, config.scale);
        mesh.position.set(...config.position);
        mesh.rotation.set(THREE.MathUtils.degToRad(config.rotation[0]), THREE.MathUtils.degToRad(config.rotation[1]), THREE.MathUtils.degToRad(config.rotation[2]));
        return mesh;
    }
}

async function generate(filename) {
    console.log(`Generating ${filename}...`);
    const startTime = performance.now();

    const config = await loadConfig(filename);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 100, -100);
    camera.lookAt(0, 0.7, 0.7);

    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // scene.add(new THREE.AxesHelper(100));

    const platform = new THREE.Mesh();
    platform.geometry = new THREE.BoxGeometry(...config.platform.size);
    platform.material = new THREE.MeshPhongMaterial({color: config.platform.color});
    scene.add(platform);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(100, 100, 100);
    scene.add(directionalLight);

    const sun = new THREE.Mesh();
    sun.geometry = new THREE.SphereGeometry(config.sun.radius);
    sun.material = new THREE.MeshBasicMaterial({
        color: config.sun.color,
        transparent: true,
        opacity: 0.7
    });
    sun.position.copy(directionalLight.position);
    scene.add(sun);

    const meshGroup = new THREE.Group();
    const parts = ["fuselage", "cockpit", "rear", "leftwing", "rightwing", "rudder",
        "leftelevator", "rightelevator", "leftengine1", "rightengine1"];
    for (const partName of parts) {
        const partConfig = config[partName];
        if (!partConfig) continue;
        const partStr = parseLsystem(partConfig.axiom, partConfig.iterationCount, new Map(Object.entries(partConfig.rules)));
        const part = drawLsystem(partStr, partConfig);
        meshGroup.add(part);
    }
    scene.add(meshGroup);

    const initialPosition = new THREE.Vector3();
    const initialRotation = new THREE.Euler();
    initialPosition.copy(meshGroup.position);
    initialRotation.copy(meshGroup.rotation);

    const clock = new THREE.Clock();
    var deltaTime;
    const moveSpeed = 100;
    const rotateSpeed = 1;

    var followPlane = false;

    function animate() {
        deltaTime = clock.getDelta();

        if (keys['w']) {
            meshGroup.translateZ(deltaTime * moveSpeed);
        }
        if (keys['s']) {
            meshGroup.translateZ(deltaTime * -moveSpeed);
        }
        if (keys['d']) {
            meshGroup.rotateY(deltaTime * -rotateSpeed);
        }
        if (keys['a']) {
            meshGroup.rotateY(deltaTime * rotateSpeed);
        }
        if (keys['ArrowUp']) {
            meshGroup.rotateX(deltaTime * rotateSpeed);
        }
        if (keys['ArrowDown']) {
            meshGroup.rotateX(deltaTime * -rotateSpeed);
        }
        if (keys['ArrowLeft']) {
            meshGroup.rotateZ(deltaTime * -rotateSpeed);
        }
        if (keys['ArrowRight']) {
            meshGroup.rotateZ(deltaTime * rotateSpeed);
        }

        if (keys['0']) {
            meshGroup.position.copy(initialPosition);
            meshGroup.rotation.copy(initialRotation);
        }

        if (keys['1']) {
            followPlane = true;
            meshGroup.add(camera);
        }
        if (keys['2']) {
            followPlane = false;
            meshGroup.remove(camera);
        }

        if (followPlane) {
            camera.lookAt(meshGroup.position);
        } else {
            controls.update();
        }

        renderer.render(scene, camera);
    }

    renderer.setAnimationLoop(animate);

    const keys = {};
    document.addEventListener("keydown", (e) => keys[e.key] = true);
    document.addEventListener("keyup", (e) => keys[e.key] = false);

    console.log(`Finished generating ${filename} in:`, Math.round((performance.now() - startTime) * 100) / 100, `milliseconds`);
}

window.generate = generate;

generate("plane3.yml");