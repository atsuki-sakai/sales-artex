export function openMicrophone(deviceId = '') {
  const audio = {echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1, latency:{ideal:0.01}};
  if (deviceId) audio.deviceId = {exact:deviceId};
  return navigator.mediaDevices.getUserMedia({audio});
}

export function microphoneError(error) {
  if (error?.name === 'NotAllowedError') return 'ブラウザとOSの設定でマイクの使用を許可してください。';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError')
    return '選んだマイクが見つかりません。接続を確認して入力を選び直してください。';
  if (error?.name === 'NotReadableError') return 'マイクを開けません。機器の接続と他のアプリの使用状況を確認してください。';
  return error?.message || 'マイクを開けませんでした。';
}
