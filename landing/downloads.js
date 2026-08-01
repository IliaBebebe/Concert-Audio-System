(() => {
  const downloads = {
    windows: {
      label: 'Скачать для Windows',
      name: 'Windows',
      description: 'Windows 10/11 · установщик .exe',
      icon: '/assets/os-windows.svg'
    },
    macos: {
      label: 'Скачать для macOS',
      name: 'macOS',
      description: 'Intel и Apple Silicon · .dmg',
      icon: '/assets/os-apple.svg'
    },
    linux: {
      label: 'Скачать для Linux',
      name: 'Linux',
      description: 'AppImage · x64',
      icon: '/assets/os-linux.svg'
    }
  };

  const getPlatform = () => {
    const userAgent = navigator.userAgent || '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    const source = `${platform} ${userAgent}`.toLowerCase();
    const maxTouchPoints = navigator.maxTouchPoints || 0;

    if (/android|cros/.test(source)) return null;
    if (/win/.test(source)) return 'windows';
    if (/macintosh|mac os x|mac/.test(source) && maxTouchPoints <= 1) return 'macos';
    if (/linux|x11/.test(source)) return 'linux';
    return null;
  };

  const detectedPlatform = getPlatform();
  const options = Array.from(document.querySelectorAll('[data-platform]'));
  const primaryDownload = document.querySelector('[data-primary-download]');
  const primaryLabel = document.querySelector('[data-primary-label]');
  const primaryIcon = document.querySelector('[data-primary-icon]');
  const status = document.querySelector('[data-download-status]');
  const intro = document.querySelector('[data-download-intro]');
  const showAllButton = document.querySelector('[data-show-all-downloads]');

  const showAll = () => {
    options.forEach((option) => {
      option.hidden = false;
      option.classList.remove('detected-download');
    });
    if (status) status.textContent = 'Выберите сборку для вашей операционной системы.';
    if (showAllButton) showAllButton.hidden = true;
  };

  if (!detectedPlatform || !downloads[detectedPlatform]) {
    showAll();
    if (intro) {
      intro.textContent = 'Не удалось определить систему. Выберите подходящую версию ниже.';
    }
    return;
  }

  const current = downloads[detectedPlatform];
  const selectedOption = options.find((option) => option.dataset.platform === detectedPlatform);

  options.forEach((option) => {
    const selected = option === selectedOption;
    option.hidden = !selected;
    option.classList.toggle('detected-download', selected);
  });

  if (primaryDownload && selectedOption) primaryDownload.href = selectedOption.href;
  if (primaryLabel) primaryLabel.textContent = current.label;
  if (primaryIcon) primaryIcon.src = current.icon;
  if (status) status.textContent = `Определена ${current.name}: ${current.description}.`;
  if (intro) intro.textContent = `Мы определили ${current.name} и подготовили подходящий файл.`;
  if (showAllButton) {
    showAllButton.hidden = false;
    showAllButton.addEventListener('click', showAll);
  }
})();
