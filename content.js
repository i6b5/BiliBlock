/**
 * B站视频卡片净化器 - 内容脚本 (Content Script)
 */

(function () {
  'use strict';

  // 默认配置
  let config = {
    settings: {
      enabled: true,
      scope: 'home',       // 'home' 仅首页 | 'all' 全站
      aggressive: false   // 激进模式 (true: 彻底隐藏让位 | false: 黑色卡片占位)
    },
    titleKeywords: [],
    exactAuthorKeywords: [], // 完全匹配特定作者名
    authorKeywords: []      // 模糊匹配作者名
  };

  // 检查当前页面是否属于生效范围
  function isPageInScope() {
    if (!config.settings.enabled) return false;
    if (config.settings.scope === 'all') return true;

    // 仅首页判断
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    const isHome =
      (hostname === 'www.bilibili.com' || hostname === 'bilibili.com') &&
      (pathname === '/' || pathname === '/index.html' || pathname === '');
    return isHome;
  }

  // 从 storage 读取最新配置
  function loadConfig(callback) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['settings', 'titleKeywords', 'exactAuthorKeywords', 'authorKeywords', 'defaultCleared_v1'], (res) => {
        if (res.settings) config.settings = Object.assign(config.settings, res.settings);
        if (Array.isArray(res.titleKeywords)) {
          config.titleKeywords = !res.defaultCleared_v1
            ? res.titleKeywords.filter((k) => k !== '社保')
            : res.titleKeywords;
        }
        if (Array.isArray(res.exactAuthorKeywords)) config.exactAuthorKeywords = res.exactAuthorKeywords;
        if (Array.isArray(res.authorKeywords)) config.authorKeywords = res.authorKeywords;

        // 如果存在未清理的旧默认词，顺便同步清理 storage
        if (!res.defaultCleared_v1 && Array.isArray(res.titleKeywords) && res.titleKeywords.includes('社保')) {
          chrome.storage.local.set({
            titleKeywords: config.titleKeywords,
            defaultCleared_v1: true
          });
        }

        if (callback) callback();
      });
    } else {
      if (callback) callback();
    }
  }

  // 监听配置更新（popup 修改后无缝生效）
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.settings) config.settings = Object.assign(config.settings, changes.settings.newValue);
        if (changes.titleKeywords) config.titleKeywords = changes.titleKeywords.newValue || [];
        if (changes.exactAuthorKeywords) config.exactAuthorKeywords = changes.exactAuthorKeywords.newValue || [];
        if (changes.authorKeywords) config.authorKeywords = changes.authorKeywords.newValue || [];
        reEvaluateAllCards();
      }
    });
  }

  // 获取卡片最外层网格容器（Grid Item）
  function getOuterCard(cardNode) {
    return (
      cardNode.closest('.feed-card') ||
      cardNode.closest('.bili-feed-card') ||
      cardNode.closest('.video-page-card-small') ||
      cardNode.closest('.video-item') ||
      cardNode.closest('.bili-video-card') ||
      cardNode
    );
  }

  // 判断是否命中关键词
  function checkBlocked(title, author) {
    const cleanTitle = (title || '').trim().toLowerCase();
    const cleanAuthor = (author || '').trim();
    const cleanAuthorLower = cleanAuthor.toLowerCase();

    // 1. 完全匹配作者名（精确相等，忽略前后空格，大小写不敏感）
    for (const exactName of config.exactAuthorKeywords) {
      const cleanExact = (exactName || '').trim();
      if (cleanExact && cleanAuthorLower === cleanExact.toLowerCase()) {
        return { blocked: true, type: 'exactAuthor', keyword: cleanAuthor || exactName };
      }
    }

    // 2. 标题模糊包含匹配
    for (const kw of config.titleKeywords) {
      const cleanKw = (kw || '').trim().toLowerCase();
      if (cleanKw && cleanTitle.includes(cleanKw)) {
        return { blocked: true, type: 'title', keyword: kw };
      }
    }

    // 3. 作者模糊包含匹配
    for (const kw of config.authorKeywords) {
      const cleanKw = (kw || '').trim().toLowerCase();
      if (cleanKw && cleanAuthorLower.includes(cleanKw)) {
        return { blocked: true, type: 'author', keyword: kw };
      }
    }

    return { blocked: false };
  }

  // 创建黑色屏蔽卡片 DOM (普通模式)
  function createBlockedCardElement(reason, onRestore) {
    const card = document.createElement('div');
    card.className = 'bili-blocker-card';

    let reasonLabel = '已屏蔽';
    if (reason.type === 'exactAuthor') {
      reasonLabel = 'UP主精准屏蔽';
    } else if (reason.type === 'author') {
      reasonLabel = 'UP主包含';
    } else if (reason.type === 'title') {
      reasonLabel = '标题包含';
    }

    const reasonText = `${reasonLabel} <span class="bili-blocker-keyword">「${escapeHtml(reason.keyword)}」</span>`;

    card.innerHTML = `
      <svg class="bili-blocker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
      <div class="bili-blocker-title">已屏蔽此视频</div>
      <div class="bili-blocker-reason" title="${escapeHtml(reason.keyword)}">${reasonText}</div>
      <button class="bili-blocker-restore-btn" type="button" title="在原位置临时查看此视频卡片">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
        临时查看
      </button>
    `;

    const restoreBtn = card.querySelector('.bili-blocker-restore-btn');
    if (restoreBtn) {
      const handleRestore = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (onRestore) onRestore();
      };
      restoreBtn.addEventListener('click', handleRestore, true);
    }

    return card;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 处理单个视频卡片
  function processCard(cardNode) {
    if (!cardNode || !(cardNode instanceof HTMLElement)) return;

    // 提取标题
    const titleEl =
      cardNode.querySelector('.bili-video-card__info--tit a') ||
      cardNode.querySelector('.bili-video-card__info--tit') ||
      cardNode.querySelector('.title') ||
      cardNode.querySelector('.bili-video-card__title') ||
      cardNode.querySelector('a[title]');

    const title = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent || '') : '';

    // 提取作者
    const authorEl =
      cardNode.querySelector('.bili-video-card__info--author') ||
      cardNode.querySelector('.bili-video-card__info--owner') ||
      cardNode.querySelector('.up-name') ||
      cardNode.querySelector('.bili-video-card__author') ||
      cardNode.querySelector('a[href*="space.bilibili.com"]');

    const author = authorEl ? (authorEl.getAttribute('title') || authorEl.textContent || '') : '';

    // 如果标题和作者都未渲染完毕，暂不处理（等待后续异步渲染）
    if (!title && !author) return;

    const outerCard = getOuterCard(cardNode);
    const targetWrapper = cardNode.classList.contains('bili-video-card')
      ? cardNode
      : cardNode.querySelector('.bili-video-card') || cardNode;

    const hit = checkBlocked(title, author);

    if (hit.blocked) {
      if (config.settings.aggressive) {
        // 激进模式：彻底隐藏最外层网格容器，让出位置给下一个视频
        applyAggressiveBlock(outerCard, targetWrapper);
      } else {
        // 普通模式：黑色卡片原位覆盖占位
        applyNormalBlock(outerCard, targetWrapper, hit);
      }
    } else {
      removeBlock(outerCard, targetWrapper);
    }
  }

  // 激进模式：彻底隐藏最外层网格容器
  function applyAggressiveBlock(outerCard, targetWrapper) {
    // 移除普通模式的黑卡与临时按钮
    const existingBlocker = targetWrapper.querySelector(':scope > .bili-blocker-card');
    if (existingBlocker) existingBlocker.remove();

    const existingRehide = targetWrapper.querySelector(':scope > .bili-blocker-rehide-btn');
    if (existingRehide) existingRehide.remove();

    Array.from(targetWrapper.children).forEach((child) => {
      child.classList.remove('bili-blocker-masked');
    });

    targetWrapper.removeAttribute('data-bili-blocked');
    targetWrapper.removeAttribute('data-bili-revealed');

    // 最外层容器彻底隐藏
    outerCard.classList.add('bili-blocker-aggressive-hide');
    outerCard.setAttribute('data-bili-blocked', 'true');
  }

  // 普通模式：黑色卡片绝对定位原位覆盖
  function applyNormalBlock(outerCard, targetWrapper, reason) {
    // 确保外层容器处于显示状态
    outerCard.classList.remove('bili-blocker-aggressive-hide');

    // 如果用户当前已处于“临时查看”状态，不打断用户浏览
    if (targetWrapper.getAttribute('data-bili-revealed') === 'true') {
      return;
    }

    // 已经处于屏蔽状态且原因相同则跳过
    if (targetWrapper.getAttribute('data-bili-blocked') === 'true') {
      return;
    }

    targetWrapper.setAttribute('data-bili-blocked', 'true');

    // 将原有直接子元素设为透明/不可交互（不 display:none，以保证完全撑开原始宽高）
    Array.from(targetWrapper.children).forEach((child) => {
      if (!child.classList.contains('bili-blocker-card') && !child.classList.contains('bili-blocker-rehide-btn')) {
        child.classList.add('bili-blocker-masked');
      }
    });

    // 移除旧卡片及按钮
    const existingBlocker = targetWrapper.querySelector(':scope > .bili-blocker-card');
    if (existingBlocker) existingBlocker.remove();

    const existingRehide = targetWrapper.querySelector(':scope > .bili-blocker-rehide-btn');
    if (existingRehide) existingRehide.remove();

    // 创建绝对定位黑色覆盖卡片
    const blockerCard = createBlockedCardElement(reason, () => {
      // 点击“临时查看”：
      blockerCard.classList.add('bili-blocker-hidden');

      // 移除原内容的隐藏遮罩类，完全在原位置呈现
      Array.from(targetWrapper.children).forEach((child) => {
        child.classList.remove('bili-blocker-masked');
      });

      // 记录临时查看状态
      targetWrapper.setAttribute('data-bili-revealed', 'true');

      // 右上角浮现小巧的“重新屏蔽”按钮
      const existingBtn = targetWrapper.querySelector(':scope > .bili-blocker-rehide-btn');
      if (existingBtn) existingBtn.remove();

      const rehideBtn = document.createElement('button');
      rehideBtn.className = 'bili-blocker-rehide-btn';
      rehideBtn.type = 'button';
      rehideBtn.textContent = '✕ 重新屏蔽';
      rehideBtn.title = '再次遮盖此视频';

      const handleRehide = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        rehideBtn.remove();
        targetWrapper.removeAttribute('data-bili-revealed');
        blockerCard.classList.remove('bili-blocker-hidden');
        Array.from(targetWrapper.children).forEach((child) => {
          if (child !== blockerCard) {
            child.classList.add('bili-blocker-masked');
          }
        });
      };

      rehideBtn.addEventListener('click', handleRehide, true);
      targetWrapper.appendChild(rehideBtn);
    });

    targetWrapper.appendChild(blockerCard);
  }

  // 解除屏蔽
  function removeBlock(outerCard, targetWrapper) {
    if (outerCard) {
      outerCard.classList.remove('bili-blocker-aggressive-hide');
      outerCard.removeAttribute('data-bili-blocked');
    }

    if (targetWrapper) {
      targetWrapper.removeAttribute('data-bili-blocked');
      targetWrapper.removeAttribute('data-bili-revealed');

      Array.from(targetWrapper.children).forEach((child) => {
        child.classList.remove('bili-blocker-masked');
      });

      const blockerCard = targetWrapper.querySelector(':scope > .bili-blocker-card');
      if (blockerCard) blockerCard.remove();

      const rehideBtn = targetWrapper.querySelector(':scope > .bili-blocker-rehide-btn');
      if (rehideBtn) rehideBtn.remove();
    }
  }

  // 扫描页面上的所有视频卡片
  function scanPage() {
    if (!isPageInScope()) {
      // 如果不在生效范围，恢复所有被屏蔽的卡片
      document.querySelectorAll('.bili-blocker-aggressive-hide').forEach((el) => {
        el.classList.remove('bili-blocker-aggressive-hide');
        el.removeAttribute('data-bili-blocked');
      });
      document.querySelectorAll('[data-bili-blocked="true"]').forEach((wrapper) => {
        const outer = getOuterCard(wrapper);
        removeBlock(outer, wrapper);
      });
      return;
    }

    // 匹配首页与常见页面的卡片选择器
    const selectors = [
      '.feed-card',
      '.bili-video-card',
      '.video-page-card-small',
      '.bili-feed-card',
      '.video-item'
    ];

    const cards = document.querySelectorAll(selectors.join(', '));
    cards.forEach((card) => {
      processCard(card);
    });
  }

  // 重置并重新评估所有卡片（在修改词库或设置后调用）
  function reEvaluateAllCards() {
    // 先清理所有激进模式隐藏
    document.querySelectorAll('.bili-blocker-aggressive-hide').forEach((el) => {
      el.classList.remove('bili-blocker-aggressive-hide');
      el.removeAttribute('data-bili-blocked');
    });

    // 清理所有普通模式的黑卡
    document.querySelectorAll('[data-bili-blocked="true"]').forEach((wrapper) => {
      const outer = getOuterCard(wrapper);
      removeBlock(outer, wrapper);
    });

    scanPage();
  }

  // 节流处理（避免高频触发导致卡顿）
  let scheduled = false;
  function triggerScan() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scanPage();
      scheduled = false;
    });
  }

  // DOM 变动监听器（处理 B 站无限滚动与异步加载）
  const observer = new MutationObserver((mutations) => {
    let hasRelevantNodes = false;
    for (let i = 0; i < mutations.length; i++) {
      if (mutations[i].addedNodes && mutations[i].addedNodes.length > 0) {
        hasRelevantNodes = true;
        break;
      }
    }
    if (hasRelevantNodes) {
      triggerScan();
    }
  });

  // 初始化启动
  function init() {
    loadConfig(() => {
      triggerScan();

      // 开始监听 DOM 树变化
      if (document.body) {
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          observer.observe(document.body, {
            childList: true,
            subtree: true
          });
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
