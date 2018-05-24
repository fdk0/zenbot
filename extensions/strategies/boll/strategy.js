/**
 * Bolling based strategy
 *
 * Invest after a dip and  try to find a valid "line path" upside inside bollinger bands to get exit points
 *
 * @author Daniel Espendiller <daniel@espendiller.net>
 */
var z = require('zero-fill')
  , n = require('numbro')
  , bollinger = require('../../../lib/bollinger')
  , ti_hma = require('../../../lib/ti_hma')
  , ema = require('../../../lib/ema')
  , ti_stoch = require('../../../lib/ti_stoch')
  , stddev = require('../../../lib/stddev')

module.exports = {
  name: 'boll',
  description: 'Buy when out band line crossing the bottom bollinger band bottom or breakout is detected',

  getOptions: function () {
    this.option('period', 'period length, same as --period_length', String, '15m')
    this.option('period_length', 'period length, same as --period', String, '15m')

    this.option('min_periods', 'min. number of history periods', Number, 52)
    this.option('stop_lose', 'lose percentage after exit trade; so bollinger recovery faild', Number, 2.75)

    this.option('bollinger_size', 'period size', Number, 20)
    this.option('bollinger_time', 'times of standard deviation between the upper band and the moving averages', Number, 2)

    this.option('bollinger_breakout_lookbacks', 'breakout trigger: lookbacks to calculate average bollinger size', Number, 30)
    this.option('bollinger_breakout_lookback_steps', 'breakout trigger: step in lookup to visit, so visit all history random cherry-pick', Number, 3)
    this.option('bollinger_breakout_trend_ema', 'breakout trigger: ema line our band line cross from bottom', Number, 12)
    this.option('bollinger_breakout_dips', 'breakout trigger: dips in row after when allow breakout', Number, 10)
    this.option('bollinger_breakout_size_violation_pct', 'breakout trigger: bollinger band size violation in percent based on last periods to trigger breakout', Number, 80)

    this.option('bollinger_sell_touch_distance_pct', 'exit trigger: after crossing upper band distance lose to exit', Number, 0.75)

    this.option('bollinger_sell_trigger', 'Trigger sell indicator: "auto", "cross", "touch"', String, 'touch')
  },

  calculate: function () {
  },

  onPeriod: function (s, cb) {
    ema(s, 'trend_ema', 52)

    if (s.period.trend_ema && s.lookback[0] && s.lookback[0].trend_ema) {
      s.period.trend_ema_rate = (s.period.trend_ema - s.lookback[0].trend_ema) / s.lookback[0].trend_ema * 100
    }

    stddev(s, 'trend_ema_stddev', 52, 'trend_ema_rate')

    s.period.indicators = {
      'exit': {}
    }

    // calculate Bollinger Bands
    bollinger(s, 'bollinger', s.options.bollinger_size)

    if(s.period.bollinger) {
      s.period.indicators.bollinger = extractLastBollingerResult(s.period.bollinger)
    }

    ema(s, 'trend_ema_26', 26)
    ema(s, 'trend_ema_76', 76)
    ema(s, 'trend_ema_breakout', s.options.bollinger_breakout_trend_ema)

    if(s.last_signal === 'buy' && s.trend !== 'buy') {
      s.trend = 'buy'
    }

    if(s.last_signal === 'sell' && s.trend !== 'sell') {
      s.trend = 'sell'
    }

    this.option('stoch_length', 'Length for stoch calculation.', Number, 14)
    this.option('smooth_k', 'K sma length', Number, 5)
    this.option('smooth_d', 'D sma length', Number, 3)

    var calcs = [
      ti_hma(s, s.options.min_periods, 9).then(function(signal) {
        s.period['trend_hma'] = signal
      }).catch(function() {

      }),
      ti_hma(s, s.options.min_periods, 2).then(function(signal) {
        s.period['trend_hma_fast'] = signal
      }).catch(function() {

      }),
      ti_hma(s, s.options.min_periods, 21).then(function(signal) {
        s.period['trend_hma_exit'] = signal
      }).catch(function() {

      }),
      ti_hma(s, s.options.min_periods, 54).then(function(signal) {
        s.period['trend_hma_bull'] = signal
      }).catch(function() {

      }),

      // exit
      ti_hma(s, s.options.min_periods, 9).then(function(signal) {
        s.period.indicators.exit.signal = signal
      }).catch(function() {
      }),
      ti_hma(s, s.options.min_periods, 21).then(function(signal) {
        s.period.indicators.exit.fast = signal
      }).catch(function() {
      }),
      ti_hma(s, s.options.min_periods, 54).then(function(signal) {
        s.period.indicators.exit.slow = signal
      }).catch(function() {
      }),

      ti_stoch(s, s.options.min_periods, 42, 9, 9).then(function(signal) {
        if(!signal) {
          return
        }

        s.period.indicators.stoch = {
          'slowK': signal['k'],
          'slowD': signal['d'],
          'pct': signal['k'] - signal['d'],
        }
      }).catch(function(error) {
        console.log(error)
      })
    ]

    Promise.all(calcs).then(() => {
      let trendHma = s.period.trend_hma

      if (s.period.bollinger) {

        let upperBound = s.period.bollinger.upper[s.period.bollinger.upper.length-1]
        let lowerBound = s.period.bollinger.lower[s.period.bollinger.lower.length-1]

        if(s.lookback[0].trend_hma < lowerBound && trendHma > lowerBound) {
          triggerBuy(s, 'lower_cross')
        } else if(s.trend !== 'sell' && shouldSell(s)) {
          s.trend = 'sell'
          s.signal = 'sell'

          s.trigger = null
        }

        if (s.trend !== 'buy'
          && s.lookback[0].trend_hma < s.lookback[0].trend_ema_breakout // break
          && s.period.trend_hma > s.period.trend_ema_breakout
        ) {

          let bollingerBreakout = getBollingerBreakout(s.lookback)

          if (bollingerBreakout.bolling_band_size_percent) {
            let averageBandSizeCompare = percent(bollingerBreakout.bolling_band_size_percent, getAverageBandSize(
              s.lookback,
              s.options.bollinger_breakout_lookbacks,
              s.options.bollinger_breakout_lookback_steps
            ))

            if(bollingerBreakout.since > 10) {
              s.period.breakout_pct = averageBandSizeCompare

              if(s.period.trend_hma > s.period.trend_ema_76 && s.period.trend_ema_26 > s.period.trend_ema_76) {
                triggerBuy(s, 'bear_dip')
              }

              if(averageBandSizeCompare > s.options.bollinger_breakout_size_violation_pct) {
                console.log('Breakout buy at: ' + n(averageBandSizeCompare).format('0.0') + ' %')

                triggerBuy(s, 'violation_dip')
              }
            }
          }
        }

        s.upper = trendHma > upperBound ? (s.upper || 0) + 1 : 0
        s.lower = trendHma < lowerBound ? (s.lower || 0) + 1 : 0
      }

      cb()
    })
  },

  onReport: function (s) {
    var cols = []

    if (typeof s.period.trend_ema_stddev === 'number') {
      let speed = getMovingSpeed(s.period)

      let color = 'grey'

      if (speed > 0) {
        color = 'green'
      } else if (speed < 0) {
        color = 'red'
      }

      cols.push(z(9, n(s.period.trend_ema_rate).format('+0.000')[color], ' ') + ' ')
    } else {
      cols.push(z(9, '', ' '))
    }

    if (s.period.bollinger) {
      if (s.period.bollinger.upper && s.period.bollinger.lower) {

        let upperBound = s.period.bollinger.upper[s.period.bollinger.upper.length-1]
        let lowerBound = s.period.bollinger.lower[s.period.bollinger.lower.length-1]
        let midBound = s.period.bollinger.mid[s.period.bollinger.mid.length-1]

        let text = n(s.period.trend_hma).format('+00.00')

        if (s.period.trend_hma > upperBound) {
          text += ' ' + n(percent(s.period.trend_hma, upperBound)).format('+0.00')
        } else if (s.period.trend_hma < midBound && s.period.trend_hma > lowerBound) {
          text += ' ' + n(percent(midBound, s.period.trend_hma)).format('+0.00')
        }

        let signal = z(15, text, ' ')

        if (s.period.trend_hma > lowerBound && s.period.trend_hma < midBound) {
          cols.push(signal.yellow)
        } else if (s.period.trend_hma < lowerBound) {
          cols.push(signal.red)
        } else if (s.period.trend_hma > midBound && s.period.trend_hma < upperBound) {
          cols.push(signal.green)
        } else if (s.period.trend_hma > upperBound) {
          cols.push(signal.bold.green)
        }

        let range = upperBound - lowerBound

        let upper = Math.abs(((s.period.trend_hma - upperBound) / range) * 100)
        let lower = Math.abs(((s.period.trend_hma - lowerBound) / range) * 100)

        cols.push(z(8, n(upper).format('0.0'), ' ').cyan)
        cols.push(z(8, n(lower).format('0.0'), ' ').cyan)

        cols.push(z(8, n(s.period.indicators.bollinger.pct).format('+0.0'), ' ').cyan)
      }
    } else {
      cols.push((z(8, '', ' ')))
      cols.push((z(8, '', ' ')))
      cols.push((z(8, '', ' ')))
    }

    let breakoutPct = ''
    if(s.period.breakout_pct) {
      let color = 'grey'
      if(s.period.breakout_pct > s.options.bollinger_breakout_size_violation_pct) {
        color = 'green'
      }

      breakoutPct = (n(s.period.breakout_pct).format('+0.0') + '%')[color]
      cols.push(z(9, breakoutPct, ' '))

    } else {
      cols.push(z(9, breakoutPct, ' '))
    }

    // stoch
    if(s.period.indicators && s.period.indicators.stoch) {
      let pct = s.period.indicators.stoch.slowK - s.period.indicators.stoch.slowD
      // [s.period.indicators.stoch.slowK < 20 || s.period.indicators.stoch.slowK > 80 'bold']
      let v = n(pct).format('+00.0') + '% ' + n(s.period.indicators.stoch.slowK).format('00')

      if(s.period.indicators.stoch.slowK < 20 || s.period.indicators.stoch.slowK > 80) {
        v = v.bold
      }

      cols.push(z(15, v[pct > 0 ? 'green' : 'red'], ' '))
    } else {
      cols.push(z(15, '', ' '))
    }

    cols.push(z(15, s.trigger ? s.trigger : '', ' ').grey)

    return cols
  },
}

function getBandSizeInPercent(bollinger) {
  return (bollinger.upper - bollinger.lower) / bollinger.upper * 100
}

/**
 * Get the average band size on history; to check if current band size is in violation
 */
function getAverageBandSize(myLookback, breakoutLookbacks, breakoutLookbacksSteps) {
  let bandSizes = myLookback.slice(breakoutLookbacksSteps, breakoutLookbacks).filter(function (lookback, index) {
    return typeof lookback.bollinger !== 'undefined' && index % breakoutLookbacksSteps === 0
  }).map(function (lookback) {
    return getBandSizeInPercent(extractLastBollingerResult(lookback.bollinger))
  })

  return bandSizes.reduce( ( p, c ) => p + c, 0 ) / bandSizes.length
}

function percent(value1, value2) {
  return (value1 - value2) / value1 * 100
}

function getBollingerBreakout(lookback) {
  var low = -1
  var low_boll = -1

  for (let i = 1; i < lookback.length - 100; i++) {
    let boldMid = lookback[i].bollinger.mid[lookback[i].bollinger.mid.length - 1]
    let trendHma2 = lookback[i].trend_hma

    var low_object

    if(low < 0) {
      low = lookback[i].close
      low_boll = (lookback[i].bollinger.upper[lookback[i].bollinger.upper.length - 1] - lookback[i].close) / lookback[i].bollinger.upper[lookback[i].bollinger.upper.length - 1] * 100
      low_object = extractLastBollingerResult(lookback[i].bollinger)
    }

    if(lookback[i].close < low) {
      low = lookback[i].close
      low_boll = (lookback[i].bollinger.upper[lookback[i].bollinger.upper.length - 1] - lookback[i].close) / lookback[i].bollinger.upper[lookback[i].bollinger.upper.length - 1] * 100
      low_object = extractLastBollingerResult(lookback[i].bollinger)
    }

    if(boldMid && trendHma2 > boldMid) {
      let bollTop = lookback[0].bollinger.upper[lookback[0].bollinger.upper.length - 1]

      return {
        'since': i,
        'close': lookback[i].close,
        'percent': (lookback[i].close - lookback[0].close) / lookback[i].close * 100,
        'bolling_top': (bollTop - lookback[0].close) / bollTop * 100,
        'bolling_low': low,
        'bolling_low_percent': low_boll,
        'bolling_band_size_percent': getBandSizeInPercent(low_object),
      }
    }
  }

  return {}
}

function extractLastBollingerResult(bollinger) {
  return {
    'upper': bollinger.upper[bollinger.upper.length - 1],
    'lower': bollinger.lower[bollinger.lower.length - 1],
    'mid': bollinger.mid[bollinger.mid.length - 1],
    'pct': (bollinger.upper[bollinger.upper.length - 1] - bollinger.lower[bollinger.lower.length - 1]) / bollinger.upper[bollinger.upper.length - 1] * 100,
  }
}

function shouldSell(s) {
  let trendHma = s.period.trend_hma

  if(s.buy_low_resistance && trendHma > s.buy_low_resistance.low  && trendHma < s.buy_low_resistance.high) {
    //console.log('sell block for inside resistance move: ' + JSON.stringify(s.buy_low_resistance))
    //return
  }

  let bollinger = extractLastBollingerResult(s.period.bollinger)
  let trendHmaExit = s.period.trend_hma_exit

  switch (s.options.bollinger_sell_trigger) {
  case 'cross':
    // middle crossed middle
    if(trendHma < bollinger.upper && s.lookback[0].trend_hma > bollinger.upper) {
      console.log('Sell based on upper croos from top')
      return true
    }

    break
  case 'touch':
    // connection to upper band lost

    // normal band
    if(trendHma > bollinger.upper) {
      return false
    }

    var crossElements = getUpperLookbacks(s.lookback, s.options.bollinger_sell_touch_distance_pct).map(function (lookback) {
      return {
        'price': lookback.trend_hma,
        'price_compare': lookback.indicators.bollinger.upper,
        'pct': percent(lookback.indicators.bollinger.upper, lookback.trend_hma),
      }
    })

    if(crossElements.length > 0) {
      var distance = getAvarageUpperLineTouchs(s.lookback, s.options.bollinger_sell_touch_distance_pct)
      var diff = percent(bollinger.upper, s.period.trend_hma)

      if(diff > distance) {
        if(s.period.indicators.stoch.pct > 0) {
          //console.log('[blocked] Sell based on upper bollinger lose')
          //return false
        }

        console.log('Sell based on upper bollinger lose')
        return true
      }
    }

    break
  case 'auto':
    console.log('not supported yet'.red)
    break
  default:
    console.log('not supported sell trigger'.red)
  }

  // middle crossed middle
  if(trendHmaExit < bollinger.mid) {

    let findlastCross2 = findlastCross(s)
    if(findlastCross2 && getMovingSpeed(s.period) < 0) {

      console.log('Sell based on mid bollinger cross')
      //   console.log(findlastCross2)

      return true
    }

    // console.log('[blocked] Sell based on mid bollinger cross')

    //return true
  }

  if(s.period.trend_hma_exit < s.period.trend_hma_bull && s.lookback[0].trend_hma_exit > s.lookback[0].trend_hma_bull) {
    //console.log('Sell based on mid bollinger cross')
    // return true
  }

  if(s.period.close < s.lookback[0].close &&  s.period.trend_hma < s.period.indicators.bollinger.lower && s.lookback[0].trend_hma < s.lookback[0].indicators.bollinger.lower && s.lookback[1].trend_hma < s.lookback[1].indicators.bollinger.lower && s.period.indicators.stoch.pct < -1) {
    //console.log('Exit based on crossed exit lines'.red)
    //return true
  }

  // drop under lower line; take lose or wait for recovery
  if(s.lower > 0) {
    // on init and restart force a sell signal on non price
    if(typeof s.last_buy_price === 'undefined') {
      console.log('Dropper under upper sell without price'.red)
      return true
    }

    let loss = ((s.last_buy_price - trendHma) / s.hma_buy * 100)
    let loss2 = ((s.last_buy_price - s.period.close) / s.hma_buy * 100)

    if(((loss + loss2) / 2) > s.options.stop_lose) {
      console.log((('Secure sell take lost of ' + n(loss).format('0.00')) + ' %').red)
      return true
    }
  }

  return false
}

function getUpperLookbacks(lookbacks, distance)
{
  let sinceIndex = -1

  let slice = lookbacks.slice(0, 10).filter(function(lookback) {
    return typeof lookback.trend_hma !== 'undefined'  && lookback.indicators.bollinger && typeof lookback.indicators.bollinger.upper !== 'undefined'
  })

  for (var x in slice) {
    let lookback = lookbacks[x]

    if(lookback.trend_hma > lookback.indicators.bollinger.upper && percent(lookback.trend_hma, lookback.indicators.bollinger.upper) > distance) {
      sinceIndex = x
    }
  }

  if (sinceIndex <= 0) {
    return []
  }

  return lookbacks.slice(0, ++sinceIndex)
}

function getAvarageUpperLineTouchs(lookback, distancePct) {
  let percentages = []

  for (let i = 0; i <= 10; i++) {
    if(!lookback[i].bollinger) {
      continue
    }

    let bollinger = extractLastBollingerResult(lookback[i].bollinger)

    let percentage = percent(bollinger.upper, lookback[i].trend_hma)
    if(percentage < 0) {
      percentage = 0
    }

    percentages.push(percentage)

    if(percentage > distancePct) {
      break
    }
  }

  return percentages.reduce( ( p, c ) => p + c, 0 ) / percentages.length
}

function triggerBuy(s, trigger) {
  s.trigger = trigger

  // cross up lower band
  if (s.trend !== 'buy') {
    s.trend = 'buy'
    s.signal = 'buy'
  }

  s.upper = 0
  s.lower = 0

  // last buy price based on hma price value
  s.hma_buy = s.period.trend_hma


  let resistanceDrop = s.hma_buy
  s.lookback.slice(0, 7).forEach(function (lookback) {
    if(lookback.low < resistanceDrop) {
      resistanceDrop = lookback.low
    }
  })

  s.buy_low_resistance = {
    'low': resistanceDrop * 0.995,
    'high': s.hma_buy * 1.015,
  }
}

function findlastCross(s) {
  let found = null

  let lastCross = null

  let visit = s.lookback.slice(0, 5)

  for (let i = 0; i < visit.length; i++) {
    if(visit[i].indicators.bollinger && visit[i].trend_hma_exit > visit[i].indicators.bollinger.mid) {
      lastCross = visit
    }
  }

  // no cross in range
  if(!lastCross) {
    return found
  }

  s.lookback.slice(0, 5).forEach(function (lookback) {
    //
    if (
      getMovingSpeed(lookback) < 0
      && (s.buy_low_resistance && !(lookback.trend_hma > s.buy_low_resistance.low && lookback.trend_hma < s.buy_low_resistance.high)) // inside resistance buy
      && lookback.trend_hma_exit > s.period.trend_hma_exit
      && lookback.trend_hma_fast < lookback.trend_hma
      && lookback.trend_hma_exit < lookback.indicators.bollinger.mid
      && lookback.indicators.stoch.pct < 0
    ) {
      found = lookback
    }
  })

  return found
}

function getMovingSpeed(period) {
  if (period.trend_ema_rate > period.trend_ema_stddev) {
    return 1
  } else if (period.trend_ema_rate < period.trend_ema_stddev * -1) {
    return -1
  }

  return 0
}
