/* =========================================================================
drills.js — practice drills with metrics feedback.
========================================================================= */
'use strict';
window.Drills = (function () {
    var activeName = null;
    var _data = null;
    var _onComplete = null;

    function start(name, onComplete) {
        if (activeName) end();
        activeName = name;
        _onComplete = onComplete || null;
        _data = { elapsed: 0 };
        if (name === 'hover') {
            _data.spawnSet = false;
            _data.driftSqSum = 0; _data.driftCount = 0; _data.maxDrift = 0;
            _data.thrSum = 0; _data.thrSqSum = 0; _data.thrCount = 0;
            _data.duration = 30;
        } else if (name === 'land') {
            _data.wasAirborne = false;
            _data.contactVSpeed = null; _data.contactLSpeed = null;
            _data.settleStart = null; _data.settleTime = null;
            _data.done = false;
        } else if (name === 'eight') {
            _data.pathLength = 0; _data.lastSet = false;
            _data.maxDeviation = 0; _data.crossings = 0;
            _data.lastSide = 0; _data.centerSet = false;
        } else if (name === 'orbit') {
            _data.centerSet = false;
            _data.radSum = 0; _data.radSqSum = 0; _data.radCount = 0;
            _data.lastAngle = null; _data.totalAngle = 0;
        }
    }

    function tick(drone, dt) {
        if (!activeName || !_data) return;
        _data.elapsed += dt;

        if (activeName === 'hover') {
            if (!_data.spawnSet) {
                _data.sx = drone.position.x;
                _data.sy = drone.position.y;
                _data.sz = drone.position.z;
                _data.spawnSet = true;
            }
            var dx = drone.position.x - _data.sx;
            var dy = drone.position.y - _data.sy;
            var dz = drone.position.z - _data.sz;
            var drift = Math.sqrt(dx*dx + dy*dy + dz*dz);
            _data.driftSqSum += drift * drift;
            _data.driftCount++;
            if (drift > _data.maxDrift) _data.maxDrift = drift;
            var thr = drone.throttleIn || 0;
            _data.thrSum += thr;
            _data.thrSqSum += thr * thr;
            _data.thrCount++;
            if (_data.elapsed >= _data.duration) end();

        } else if (activeName === 'land') {
            var grounded = (drone._groundedTime || 0) > 0;
            if (!_data.wasAirborne && !grounded && drone.position.y > 0.5) {
                _data.wasAirborne = true;
            }
            if (_data.wasAirborne && grounded && !_data.done) {
                _data.contactVSpeed = Math.abs(drone.velocity.y);
                _data.contactLSpeed = Math.sqrt(
                    drone.velocity.x * drone.velocity.x +
                    drone.velocity.z * drone.velocity.z);
                _data.settleStart = _data.elapsed;
                _data.done = true;
            }
            if (_data.done && _data.settleTime === null) {
                var spd = drone.velocity.length();
                if (spd < 0.1) {
                    _data.settleTime = _data.elapsed - _data.settleStart;
                    end();
                }
            }

        } else if (activeName === 'eight') {
            if (!_data.centerSet) {
                _data.cx = drone.position.x;
                _data.cz = drone.position.z;
                _data.centerSet = true;
            }
            if (_data.lastSet) {
                var ex = drone.position.x - _data.lx;
                var ey = drone.position.y - _data.ly;
                var ez = drone.position.z - _data.lz;
                _data.pathLength += Math.sqrt(ex*ex + ey*ey + ez*ez);
            }
            _data.lx = drone.position.x;
            _data.ly = drone.position.y;
            _data.lz = drone.position.z;
            _data.lastSet = true;
            var devx = drone.position.x - _data.cx;
            var devz = drone.position.z - _data.cz;
            var dev = Math.sqrt(devx*devx + devz*devz);
            if (dev > _data.maxDeviation) _data.maxDeviation = dev;
            var side = drone.position.x >= _data.cx ? 1 : -1;
            if (_data.lastSide !== 0 && side !== _data.lastSide) {
                _data.crossings++;
            }
            _data.lastSide = side;

        } else if (activeName === 'orbit') {
            if (!_data.centerSet) {
                _data.cx = drone.position.x;
                _data.cz = drone.position.z;
                _data.centerSet = true;
            }
            var ox = drone.position.x - _data.cx;
            var oz = drone.position.z - _data.cz;
            var radius = Math.sqrt(ox*ox + oz*oz);
            if (radius > 1.0) {
                _data.radSum += radius;
                _data.radSqSum += radius * radius;
                _data.radCount++;
            }
            var angle = Math.atan2(oz, ox);
            if (_data.lastAngle !== null) {
                var dA = angle - _data.lastAngle;
                while (dA > Math.PI) dA -= 2 * Math.PI;
                while (dA < -Math.PI) dA += 2 * Math.PI;
                _data.totalAngle += dA;
            }
            _data.lastAngle = angle;
        }
    }

    function end() {
        if (!activeName) return null;
        var m = computeMetrics();
        var cb = _onComplete;
        activeName = null;
        _data = null;
        _onComplete = null;
        if (cb && m) cb(m);
        return m;
    }

    function computeMetrics() {
        if (!_data) return null;
        var m = { name: activeName.toUpperCase() };
        if (activeName === 'hover') {
            var n = _data.driftCount;
            m.driftRMS = n > 0 ? Math.sqrt(_data.driftSqSum / n) : 0;
            m.maxDrift = _data.maxDrift;
            var tn = _data.thrCount;
            var tMean = tn > 0 ? _data.thrSum / tn : 0;
            var tVar = tn > 0 ? (_data.thrSqSum / tn) - (tMean * tMean) : 0;
            m.throttleStdDev = Math.sqrt(Math.max(0, tVar));
            m.duration = _data.elapsed;
        } else if (activeName === 'land') {
            m.contactVSpeed = _data.contactVSpeed;
            m.contactLSpeed = _data.contactLSpeed;
            m.settleTime = _data.settleTime;
        } else if (activeName === 'eight') {
            m.pathLength = _data.pathLength;
            m.maxDeviation = _data.maxDeviation;
            m.crossings = _data.crossings;
        } else if (activeName === 'orbit') {
            var rn = _data.radCount;
            var rMean = rn > 0 ? _data.radSum / rn : 0;
            var rVar = rn > 0 ? (_data.radSqSum / rn) - (rMean * rMean) : 0;
            m.radiusMean = rMean;
            m.radiusStdDev = Math.sqrt(Math.max(0, rVar));
            m.driftRate = _data.elapsed > 0 ? m.radiusStdDev / _data.elapsed : 0;
            m.totalAngle = Math.abs(_data.totalAngle);
        }
        return m;
    }

    function isActive() { return activeName !== null; }
    function getActiveName() { return activeName; }
    function getMetrics() { return _data ? computeMetrics() : null; }

    return {
        start: start,
        tick: tick,
        end: end,
        isActive: isActive,
        getActiveName: getActiveName,
        getMetrics: getMetrics
    };
})();
