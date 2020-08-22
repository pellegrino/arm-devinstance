import ec2 = require("@aws-cdk/aws-ec2");
import cdk = require("@aws-cdk/core");
import autoscaling = require("@aws-cdk/aws-autoscaling");
import autoscalingTargets = require("@aws-cdk/aws-autoscaling-hooktargets");
import lambda = require("@aws-cdk/aws-lambda");
import iam = require("@aws-cdk/aws-iam");
import fs = require("fs");
import nunjuncks = require("nunjucks");

interface Props extends cdk.StackProps {
	readonly hostedZoneId: string;
	readonly dnsName: string;
	readonly sshKeyName: string;
}

class ARMDevelopmentInstance extends cdk.Stack {
	constructor(scope: cdk.App, id: string, props: Props) {
		super(scope, id, props);

		const vpc = new ec2.Vpc(this, "devInstancesVPC", { maxAzs: 1 });
		const deviceName = "xvdz";
		const targetDevice = "/dev/" + deviceName;
		const mountPath = "/home";

		const devInstanceSecurityGroup = new ec2.SecurityGroup(
			this,
			"developmentInstanceSecurityGroup",
			{
				vpc,
				allowAllOutbound: true,
			}
		);

		devInstanceSecurityGroup.addIngressRule(
			ec2.Peer.anyIpv4(),
			ec2.Port.tcp(22),
			"allow public ssh traffic"
		);

		const ebsVolume = new ec2.Volume(this, 'Volume', {
			availabilityZone: vpc.availabilityZones[0],
			size: cdk.Size.gibibytes(50),
			encrypted: true,
		});

		const asgInstancesRole = new iam.Role(this, "DevelopmentArmRole", {
			assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
			managedPolicies: [
				iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ReadOnlyAccess"),
			],
		});

		ebsVolume.grantAttachVolume(asgInstancesRole);
		ebsVolume.grantDetachVolume(asgInstancesRole);

		const mountScript: string = fs.readFileSync(
			"./ebs-nvme-mapping.sh.j2",
			"utf8"
		);

		const userDataScript: string = nunjuncks.renderString(mountScript, {
			mountPath: mountPath,
			ebsVolumeId: ebsVolume.volumeId,
			deviceName: deviceName,
			targetDevice: targetDevice,
		});

		const userData = ec2.UserData.forLinux();
		userData.addCommands(userDataScript);

		const autoScale = new autoscaling.AutoScalingGroup(this, "developmentBox", {
			vpc,
			associatePublicIpAddress: true,
			role: asgInstancesRole,
			instanceType: ec2.InstanceType.of(
				ec2.InstanceClass.M6G,
				ec2.InstanceSize.MEDIUM
			),
			spotPrice: "1",
			minCapacity: 0,
			maxCapacity: 1,
			userData: userData,
			keyName: props.sshKeyName,
			vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
			machineImage: new ec2.LookupMachineImage({
				name: "ubuntu*20.04*",
				filters: {
					architecture: ["arm64"],
				},
			}),
		});

		autoScale.scaleOnSchedule("scalingUp", {
			schedule: autoscaling.Schedule.cron({
				weekDay: "MON-FRI",
				hour: "09",
				minute: "0",
			}),
			desiredCapacity: 1,
		});

		autoScale.scaleOnSchedule("scalingDown", {
			schedule: autoscaling.Schedule.cron({
				weekDay: "MON-FRI",
				hour: "20",
				minute: "0",
			}),
			desiredCapacity: 0,
		});

		autoScale.addSecurityGroup(devInstanceSecurityGroup);

		const route53RegistrationRole = new iam.Role(this, "ManageRoute53", {
			assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),

			managedPolicies: [
				iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ReadOnlyAccess"),
				iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonRoute53FullAccess"),
				iam.ManagedPolicy.fromAwsManagedPolicyName("AWSLambdaExecute"),
			],
		});

		const registerLambda = new lambda.Function(this, "registerLambda", {
			description: "Updates DNS entries when instance is created",
			runtime: lambda.Runtime.PYTHON_3_8,
			handler: "index.lambda_handler",
			timeout: cdk.Duration.minutes(2),
			code: lambda.Code.fromAsset("updateRoute53"),
			role: route53RegistrationRole,
			environment: {
				HostedZoneId: props.hostedZoneId,
				HostDns: props.dnsName,
				AutoScalingGroupName: autoScale.autoScalingGroupName,
			},
		});

		const deregisterLambda = new lambda.Function(this, "deregisterLambda", {
			description: "Updates DNS entries when instance is destroyed",
			runtime: lambda.Runtime.PYTHON_3_8,
			handler: "index.lambda_handler",
			timeout: cdk.Duration.minutes(2),
			code: lambda.Code.fromAsset("updateRoute53"),
			role: route53RegistrationRole,
			environment: {
				HostedZoneId: props.hostedZoneId,
				HostDns: props.dnsName,
				AutoScalingGroupName: autoScale.autoScalingGroupName,
			},
		});

		autoScale.addLifecycleHook("resigsterDnsNameLambda", {
			lifecycleHookName: "registerDnsName",
			lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_LAUNCHING,
			defaultResult: autoscaling.DefaultResult.CONTINUE,
			heartbeatTimeout: cdk.Duration.minutes(2),
			notificationTarget: new autoscalingTargets.FunctionHook(registerLambda),
		});

		autoScale.addLifecycleHook("deregisterDnsNameLambda", {
			lifecycleHookName: "deregisterDnsName",
			lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
			heartbeatTimeout: cdk.Duration.minutes(2),
			defaultResult: autoscaling.DefaultResult.CONTINUE,
			notificationTarget: new autoscalingTargets.FunctionHook(deregisterLambda),
		});
	}
}

const app = new cdk.App();
new ARMDevelopmentInstance(app, "arm-development-autoscaling", {
	hostedZoneId: process.env["HOSTED_ZONE_ID"]!,
	dnsName: process.env["DEV_INSTANCE_DNS_NAME"]!,
	sshKeyName: process.env["SSH_KEY_NAME"]!,
	env: {
		region: process.env["CDK_DEFAULT_REGION"],
		account: process.env["CDK_DEFAULT_ACCOUNT"],
	},
});
app.synth();
