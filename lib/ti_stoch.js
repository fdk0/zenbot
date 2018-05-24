let ti = require('tulind')

module.exports = function volume(s, min_periods, fastkPeriod, slowkPeriod, slowdPeriod) {
  return new Promise(function(resolve) {
    let marketData = { open: [], close: [], high: [], low: [], volume: [] }

    s.lookback.slice(0, 1000).reverse().forEach(function (lookback) {
      marketData.high.push(lookback.high)
      marketData.low.push(lookback.low)
      marketData.close.push(lookback.close)
      marketData.volume.push(lookback.volume)
    })

    // add current data
    marketData.high.push(s.period.high)
    marketData.low.push(s.period.low)
    marketData.close.push(s.period.close)
    marketData.volume.push(s.period.volume)

    ti.indicators.stoch.indicator([marketData.high, marketData.low, marketData.close], [fastkPeriod, slowkPeriod, slowdPeriod], function(err, results) {
      resolve({
        'k': results[0][results[0].length-1],
        'd': results[1][results[1].length-1],
      })
    })
  })
}
