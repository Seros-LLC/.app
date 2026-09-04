/* ==========================================================================
   seros-ui.js — the behaviour layer

   Reading progress, section-aware navigation, staggered reveals, paper cards
   that lift under the pointer, and the deck of plates that is dealt as you
   scroll through "How it works".

   Every one of these is an enhancement over markup that already works. If
   this file never loads, the page is a complete, readable document; if the
   reader asked for less motion, the deck flattens back into a list and the
   reveals never hide anything.
   ========================================================================== */
(function () {
  'use strict';

  var reduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // One scroll listener and one rAF for the whole page. Everything that
  // depends on scroll position reads it from here.
  var onScroll = [];
  var queued = false;
  function scheduleScroll() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(function () {
      queued = false;
      for (var i = 0; i < onScroll.length; i++) { onScroll[i](); }
    });
  }
  window.addEventListener('scroll', scheduleScroll, { passive: true });
  window.addEventListener('resize', scheduleScroll, { passive: true });

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* -------------------------------------------------------------- reveals */
  (function reveals() {
    var els = [].slice.call(document.querySelectorAll('.reveal, .stagger'));
    if (!els.length) return;
    function show(el) { el.classList.add('shown'); }
    if (!('IntersectionObserver' in window) || reduced) { els.forEach(show); return; }
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { show(e.target); obs.unobserve(e.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -5% 0px' });
    els.forEach(function (el) { io.observe(el); });
    // Safety net: content must never stay hidden because an observer misfired.
    window.setTimeout(function () { els.forEach(show); }, 2400);
  }());

  /* ----------------------------------------------------- reading progress */
  (function progress() {
    var header = document.querySelector('header.site .wrap');
    if (!header) return;
    var bar = document.createElement('div');
    bar.className = 'progress';
    bar.setAttribute('aria-hidden', 'true');
    var fill = document.createElement('i');
    bar.appendChild(fill);
    header.parentNode.appendChild(bar);
    onScroll.push(function () {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      fill.style.width = (max > 0 ? clamp(doc.scrollTop / max, 0, 1) * 100 : 0) + '%';
    });
  }());

  /* --------------------------------------------------- section-aware nav */
  (function activeNav() {
    var links = [].slice.call(document.querySelectorAll('nav.site a[href*="#"]'));
    if (!links.length) return;
    var targets = links.map(function (a) {
      var id = (a.getAttribute('href') || '').split('#')[1];
      return id ? document.getElementById(id) : null;
    });
    onScroll.push(function () {
      var best = -1, bestTop = -Infinity;
      var line = window.innerHeight * 0.34;
      for (var i = 0; i < targets.length; i++) {
        if (!targets[i]) continue;
        var top = targets[i].getBoundingClientRect().top;
        if (top <= line && top > bestTop) { bestTop = top; best = i; }
      }
      links.forEach(function (a, i) { a.classList.toggle('is-here', i === best); });
    });
  }());

  /* ------------------------------------------------------------ card lift */
  (function cardTilt() {
    var groups = [].slice.call(document.querySelectorAll('[data-tilt]'));
    if (!groups.length || reduced) return;
    // A tilt is a pointing-device affectation; a touch screen has no hover.
    if (!(window.matchMedia && window.matchMedia('(hover: hover)').matches)) return;

    groups.forEach(function (group) {
      group.classList.add('is-tilt');
      var cards = [].slice.call(group.querySelectorAll('.card'));
      cards.forEach(function (card) {
        var raf = 0, tx = 0, ty = 0, cx = 50, cy = 0;
        function apply() {
          raf = 0;
          card.style.transform = 'perspective(1100px) rotateX(' + ty.toFixed(2) +
            'deg) rotateY(' + tx.toFixed(2) + 'deg) translateZ(10px)';
          card.style.setProperty('--mx', cx.toFixed(1) + '%');
          card.style.setProperty('--my', cy.toFixed(1) + '%');
        }
        card.addEventListener('pointermove', function (e) {
          var r = card.getBoundingClientRect();
          var px = (e.clientX - r.left) / Math.max(1, r.width);
          var py = (e.clientY - r.top) / Math.max(1, r.height);
          tx = (px - 0.5) * 11;
          ty = -(py - 0.5) * 8;
          cx = px * 100; cy = py * 100;
          if (!raf) raf = window.requestAnimationFrame(apply);
        }, { passive: true });
        card.addEventListener('pointerleave', function () {
          tx = 0; ty = 0; cx = 50; cy = 0;
          if (!raf) raf = window.requestAnimationFrame(apply);
        }, { passive: true });
      });
    });
  }());

  /* ------------------------------------------------------- the step deck */
  (function stepDeck() {
    var section = document.querySelector('[data-deck]');
    if (!section) return;
    var steps = [].slice.call(section.querySelectorAll('.step'));
    if (steps.length < 2) return;
    var tally = section.querySelector('[data-tally]');

    var wideEnough = function () { return window.innerWidth > 900; };
    var on = false;

    function enable() {
      if (on || reduced || !wideEnough()) return;
      on = true;
      section.classList.add('is-deck');
      place();
    }
    function disable() {
      if (!on) return;
      on = false;
      section.classList.remove('is-deck');
      steps.forEach(function (s) {
        s.style.transform = '';
        s.style.opacity = '';
        s.classList.remove('is-front');
      });
      if (tally) tally.textContent = '';
    }

    function place() {
      if (!on) return;
      var r = section.getBoundingClientRect();
      var span = Math.max(1, section.offsetHeight - window.innerHeight);
      var p = clamp(-r.top / span, 0, 1);
      var head = p * (steps.length - 1);
      var front = Math.round(head);

      for (var i = 0; i < steps.length; i++) {
        var d = i - head;                       // 0 is the plate being read
        var s = steps[i];
        if (d >= 0) {
          // Waiting behind, stacked and slightly smaller.
          s.style.transform = 'translate3d(' + (d * 26).toFixed(1) + 'px,' +
            (d * 22).toFixed(1) + 'px,' + (-d * 110).toFixed(1) + 'px) rotateY(-9deg) rotateX(' +
            (-d * 2.4).toFixed(2) + 'deg)';
          s.style.opacity = String(clamp(1.30 - d * 0.30, 0, 1));
        } else {
          // Dealt: lifts up and away, never towards the reader, or it would
          // cross in front of the plate being read.
          s.style.transform = 'translate3d(' + (d * 18).toFixed(1) + 'px,' +
            (d * 96).toFixed(1) + 'px,' + (d * 60).toFixed(1) + 'px) rotateY(' +
            (-9 + d * 6).toFixed(2) + 'deg) rotateX(' + (-d * 9).toFixed(2) + 'deg)';
          s.style.opacity = String(clamp(1 + d * 1.7, 0, 1));
        }
        s.style.zIndex = String(100 - Math.round(Math.abs(d) * 10));
        s.classList.toggle('is-front', i === front);
      }
      if (tally) {
        tally.innerHTML = 'Step <b>' + (front + 1) + '</b> of ' + steps.length;
      }
    }

    onScroll.push(place);
    window.addEventListener('resize', function () {
      if (wideEnough() && !reduced) { enable(); } else { disable(); }
    }, { passive: true });

    enable();
  }());

  scheduleScroll();
}());
