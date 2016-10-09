var util = require('util');
var AWS = require('aws-sdk');

function CloudwatchBackend(startupTime, config, emitter) {
    var self = this;

    this.config = config.cloudwatch || {};
    AWS.config = this.config;

    function setEmitter() {
        self.cloudwatch = new AWS.CloudWatch(AWS.config);
        emitter.on('flush', function(timestamp, metrics) {
            self.flush(timestamp, metrics);
        });
    }

    // if iamRole is set attempt to fetch credentials from the Metadata Service
    if (this.config.iamRole) {
        if (this.config.iamRole == 'any') {
            // If the iamRole is set to any, then attempt to fetch any available credentials
            ms = new AWS.EC2MetadataCredentials();
            ms.refresh(function(err) {
                if (err) {
                    console.log('Failed to fetch IAM role credentials: ' + err);
                }
                AWS.config.credentials = ms;
                setEmitter();
            });
        } else {
            // however if it's set to specify a role, query it specifically.
            ms = new AWS.MetadataService();
            ms.request('/latest/meta-data/iam/security-credentials/' + this.config.iamRole, function(err, rdata) {
                var data = JSON.parse(rdata);

                if (err) {
                    console.log('Failed to fetch IAM role credentials: ' + err);
                }
                AWS.config.credentials = new AWS.Credentials(data.AccessKeyId, data.SecretAccessKey, data.Token);
                setEmitter();
            });
        }
    } else {
        setEmitter();
    }
};

CloudwatchBackend.prototype.processKey = function(key) {
    var parts = key.split(/[\.\/-]/);

    return {
        metricName: parts[parts.length - 1],
        namespace: parts.length > 1 ? parts.splice(0, parts.length - 1).join("/") : null
    };
};

CloudwatchBackend.prototype.check_whitelist = function(key) {
    var blacklist =  ['production.', 'engineering.', 'staging.', 'eng.', 'prod.', 'stag.', 'dynamodb.', 'statsd.', 'sqs.']
    
    //if(!this.config.blacklist || this.config.blacklist.length == 0){
    //    this.config.blacklist = [];
    //}
    //var blacklist = this.config.blacklist;

    for(var i=0; i<blacklist.length;i++){
        var b = blacklist[i];
        if(key.indexOf(b) >= 0){
            return false;
        }
    }

    if(key.indexOf('.i-') >= 0){
        return false;
    }

    return true;
    if (!this.config.whitelist) {
        return true;
    }
    if (this.config.whitelist.length == 0) {
        return true;
    }
    for (var i = 0; i < this.config.whitelist.length; i++) {
        var w = this.config.whitelist[i];
        if(key.indexOf(w) === 0){
            return true;
        }
    }
    return false;
};

String.prototype.rsplit = function(sep, maxsplit) {
    var split = this.split(sep);
    return maxsplit ? [ split.slice(0, -maxsplit).join(sep) ].concat(split.slice(-maxsplit)) : split;
};

CloudwatchBackend.prototype.rebuild_gauges = function(gauges){
    var new_gauges = {};
    for(var key in gauges){
        var res = key.rsplit('.', 1);
        var new_key = res[0];
        var unique_key = res[1];
        if(unique_key.indexOf('sum-') == -1){
            new_gauges[key] = {key : gauges[key]};
            continue;
        }

        if(!new_gauges[new_key]){
            new_gauges[new_key] = {};
        }
        new_gauges[new_key][unique_key] = gauges[key];
        delete(gauges[key]);
    }
    var new_gauges_2 = {};
    for(var key1 in new_gauges){
        var total = 0;
        for(var key2 in new_gauges[key1]){
            total += new_gauges[key1][key2];
        }
        new_gauges_2[key1] = total;
    }
    return new_gauges_2;
};

CloudwatchBackend.prototype.flush = function(timestamp, metrics) {

    console.log('Flushing metrics at ' + new Date(timestamp * 1000).toISOString());

    var counters = metrics.counters;
    var gauges = this.rebuild_gauges(metrics.gauges);
    var timers = metrics.timers;
    var sets = metrics.sets;

    for (key in counters) {
        if (key.indexOf('statsd.') == 0)
            continue;

        if (!this.check_whitelist(key)) {
            continue;
        }
        console.log("Key (counter) " + key + " in whitelist");
            

        var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
        var namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
        var metricName = this.config.metricName || names.metricName || key;

        this.cloudwatch.putMetricData({
                MetricData: [{
                    MetricName: metricName,
                    Unit: 'Count',
                    Timestamp: new Date(timestamp * 1000).toISOString(),
                    Value: counters[key]
                }],
                Namespace: namespace
            },
            function(err, data) {
                console.log(util.inspect(err));
                console.log(util.inspect(data));
            });
    }

    for (key in timers) {
        if (timers[key].length > 0) {

            if (key.indexOf('statsd.') == 0)
                continue;

            if (!this.check_whitelist(key)) {
                continue;
            }
            console.log("Key (timer) " + key + " in whitelist");
                

            var values = timers[key].sort(function(a, b) {
                return a - b;
            });
            var count = values.length;
            var min = values[0];
            var max = values[count - 1];

            var cumulativeValues = [min];
            for (var i = 1; i < count; i++) {
                cumulativeValues.push(values[i] + cumulativeValues[i - 1]);
            }

            var sum = min;
            var mean = min;
            var maxAtThreshold = max;

            var message = "";

            var key2;

            sum = cumulativeValues[count - 1];
            mean = sum / count;

            var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
            var namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
            var metricName = this.config.metricName || names.metricName || key;

            this.cloudwatch.putMetricData({
                    MetricData: [{
                        MetricName: metricName,
                        Unit: 'Milliseconds',
                        Timestamp: new Date(timestamp * 1000).toISOString(),
                        StatisticValues: {
                            Minimum: min,
                            Maximum: max,
                            Sum: sum,
                            SampleCount: count
                        }
                    }],
                    Namespace: namespace
                },
                function(err, data) {
                    console.log(util.inspect(err));
                    console.log(util.inspect(data));
                });
        }
    }

    for (key in gauges) {

        if (!this.check_whitelist(key)) {
            continue;
        }
        console.log("Key (gauge) " + key + " in whitelist");
            

        var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
        var namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
        var metricName = this.config.metricName || names.metricName || key;

        this.cloudwatch.putMetricData({
                MetricData: [{
                    MetricName: metricName,
                    Unit: 'None',
                    Timestamp: new Date(timestamp * 1000).toISOString(),
                    Value: gauges[key]
                }],
                Namespace: namespace
            },

            function(err, data) {
                console.log(util.inspect(err));
                console.log(util.inspect(data));
            });
    }

    for (key in sets) {

        if (!this.check_whitelist(key)) {
            console.log("Key (set) " + key + " not in whitelist");
            continue;
        }

        var names = this.config.processKeyForNamespace ? this.processKey(key) : {};
        var namespace = this.config.namespace || names.namespace || "AwsCloudWatchStatsdBackend";
        var metricName = this.config.metricName || names.metricName || key;

        this.cloudwatch.putMetricData({
                MetricData: [{
                    MetricName: metricName,
                    Unit: 'None',
                    Timestamp: new Date(timestamp * 1000).toISOString(),
                    Value: sets[key].values().length
                }],
                Namespace: namespace
            },

            function(err, data) {
                console.log(util.inspect(err));
                console.log(util.inspect(data));
            });
    }
};

exports.init = function(startupTime, config, events) {
    var instance = new CloudwatchBackend(startupTime, config, events);
    return true;
};