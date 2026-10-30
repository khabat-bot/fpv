/* =========================================================================
ghost-trail.js — ring buffer of drone positions, rendered as fading line.
========================================================================= */
'use strict';
window.GhostTrail = (function() {
    var MAX_SAMPLES = 150;
    var SAMPLE_EVERY = 4;
    var frameCount = 0;
    var buffer = [];
    var line = null;
    var geometry = null;
    var material = null;
    var scene = null;

    function init(sc) {
        scene = sc;
        geometry = new THREE.BufferGeometry();
        var positions = new Float32Array(MAX_SAMPLES * 3);
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setDrawRange(0, 0);
        material = new THREE.LineBasicMaterial({
            color: 0x88ccff,
            transparent: true,
            opacity: 0.75,
            depthTest: true,
            depthWrite: false
        });
        line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.renderOrder = 999;
        scene.add(line);
    }

    function update(drone) {
        if (!line || !drone) return;
        frameCount++;
        if (frameCount % SAMPLE_EVERY !== 0) return;
        buffer.push({ x: drone.position.x, y: drone.position.y, z: drone.position.z });
        if (buffer.length > MAX_SAMPLES) buffer.shift();
        var posAttr = geometry.attributes.position;
        for (var i = 0; i < buffer.length; i++) {
            posAttr.setXYZ(i, buffer[i].x, buffer[i].y, buffer[i].z);
        }
        posAttr.needsUpdate = true;
        geometry.setDrawRange(0, buffer.length);
    }

    function clear() {
        buffer.length = 0;
        if (geometry) geometry.setDrawRange(0, 0);
    }

    function setVisible(v) {
        if (line) line.visible = v;
    }

    function dispose() {
        if (line && scene) scene.remove(line);
        if (geometry) geometry.dispose();
        if (material) material.dispose();
        buffer.length = 0;
    }

    return {
        init: init,
        update: update,
        clear: clear,
        setVisible: setVisible,
        dispose: dispose
    };
})();
