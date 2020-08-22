# Infrastructure


CDK project used to create an Auto Scaling group, able to create ARM backed instances compatible to [Remote Development with Visual Studio Code](https://code.visualstudio.com/docs/remote/ssh). 

In order to keep the costs to a minimum, the ASG has been configured as follows:

- Scale the number of instances down to 0 automatically off of Business hours. 
- Use Spot instances by default
- The home folder is mapped to an EBS volume, so that it can survive reboots or instance termination

## How to use it

TODO: Expand this section

Make sure your AWS environment is correctly configured, and export these additional variables.

```
export AWS_DEFAULT_REGION=eu-central-1 # AWS REGION
export AWS_HOSTED_ZONE_ID="" # Route53 Hosted ID 
export DEV_INSTANCE_DNS_NAME="box.example.com" # DNS name for the Development instance
export SSH_KEY_NAME="example_id_rsa" # Name for the keypair
```

I use [direnv](https://direnv.net/) locally. A sample .envrc file (.envrc.sample) is committed as part of the repo, but feel free to use whatever mechanism you prefer.


After the environment is correctly configured, use CDK to deploy it

```
vitor ~/src/github.com/pellegrino/arm-devinstance master* $ npm install                                 
vitor ~/src/github.com/pellegrino/arm-devinstance master* $ cdk bootstrap
vitor ~/src/github.com/pellegrino/arm-devinstance master* $ cdk install
```

## Architecture

TODO: Add an architecture diagram
