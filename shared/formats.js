// -----------------------------------------------------------------------------
// /shared/formats.js — the one list of card formats the sales page and the
// build-time validator share. Loaded as a classic script by swipe.html
// (window.gwmFormats) and required by validate-feeds.js (module.exports).
//
// RPR keeps its original three formats. Every other company uses the three
// lead formats, each mapped onto an EXISTING colour family so no new colours
// are introduced: the CSS on the sales page keys on the family, the text on
// the card keys on the label (the .card-format pill uppercases it, so
// "Long-form article" renders as LONG-FORM ARTICLE).
//
//   format         label               family   article?
//   pillar         Pillar              pillar   yes
//   insight        Insight             insight  yes
//   post           Post                post     no
//   long_form      Long-form article   pillar   yes
//   short_insight  Short insight       insight  yes
//   linkedin_post  LinkedIn post       post     no
//
// "article" formats are the ones the direction builder may swap for their
// sibling when a slot has no liked card of the exact format
// (pillar <-> insight, long_form <-> short_insight).
// -----------------------------------------------------------------------------
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.gwmFormats = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  var FORMATS = {
    pillar:        { label: 'Pillar',            family: 'pillar',  article: true,  sibling: 'insight' },
    insight:       { label: 'Insight',           family: 'insight', article: true,  sibling: 'pillar' },
    post:          { label: 'Post',              family: 'post',    article: false, sibling: null },
    long_form:     { label: 'Long-form article', family: 'pillar',  article: true,  sibling: 'short_insight' },
    short_insight: { label: 'Short insight',     family: 'insight', article: true,  sibling: 'long_form' },
    linkedin_post: { label: 'LinkedIn post',     family: 'post',    article: false, sibling: null }
  };
  // Direction-slot preference: pillar family first, then insight, then post.
  var ORDER    = ['pillar', 'long_form', 'insight', 'short_insight', 'post', 'linkedin_post'];
  var FAMILIES = ['pillar', 'insight', 'post'];

  function norm(f) { return String(f == null ? '' : f).toLowerCase().trim(); }
  function def(f)  { return Object.prototype.hasOwnProperty.call(FORMATS, norm(f)) ? FORMATS[norm(f)] : null; }
  function has(f)       { return !!def(f); }
  function family(f)    { var d = def(f); return d ? d.family : 'post'; }
  function label(f)     { var d = def(f); return d ? d.label : 'Post'; }
  function isArticle(f) { var d = def(f); return !!(d && d.article); }
  function sibling(f)   { var d = def(f); return d ? d.sibling : null; }

  return {
    FORMATS: FORMATS,
    ORDER: ORDER,
    FAMILIES: FAMILIES,
    list: Object.keys(FORMATS),
    has: has,
    family: family,
    label: label,
    isArticle: isArticle,
    sibling: sibling
  };
});
