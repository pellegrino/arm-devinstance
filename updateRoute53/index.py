import json
import logging
import boto3
import sys
import os

logger = logging.getLogger()
logger.setLevel(logging.INFO)

autoscaling = boto3.client('autoscaling')
ec2 = boto3.client('ec2')
route53 = boto3.client('route53')

LIFECYCLE_KEY = "LifecycleHookName"
ASG_KEY = os.environ["AutoScalingGroupName"]  # "AutoScalingGroupName"

# Fetches private IP of an instance via EC2 API


def fetch_public_ip_from_ec2(instance_id):
    logger.info("Fetching public IP for instance-id: %s", instance_id)

    ec2_response = ec2.describe_instances(InstanceIds=[instance_id])
    ip_address = ec2_response['Reservations'][0]['Instances'][0]['PublicIpAddress']

    logger.info("Found public IP for instance-id %s: %s",
                instance_id, ip_address)

    return ip_address

# Fetches public IP of an instance via route53 API


def fetch_public_ip_from_route53(hostname, zone_id):
    logger.info("Fetching public IP for hostname: %s", hostname)

    ip_address = route53.list_resource_record_sets(
        HostedZoneId=zone_id,
        StartRecordName=hostname,
        StartRecordType='A',
        MaxItems='1'
    )['ResourceRecordSets'][0]['ResourceRecords'][0]['Value']

    logger.info("Found public IP for hostname %s: %s", hostname, ip_address)

    return ip_address

# Updates a Route53 record


def update_record(zone_id, ip, hostname, operation):
    logger.info("Changing record with %s for %s -> %s in %s",
                operation, hostname, ip, zone_id)
    route53.change_resource_record_sets(
        HostedZoneId=zone_id,
        ChangeBatch={
            'Changes': [
                {
                    'Action': operation,
                    'ResourceRecordSet': {
                        'Name': hostname,
                        'Type': 'A',
                        'TTL': 300,
                        'ResourceRecords': [{'Value': ip}]
                    }
                }
            ]
        }
    )

# Processes a scaling event
# Builds a hostname from tag metadata, fetches a public IP, and updates records accordingly


def process_message(message):
    logger.info("Processing %s event", message['LifecycleTransition'])

    if message['LifecycleTransition'] == "autoscaling:EC2_INSTANCE_LAUNCHING":
        operation = "UPSERT"
    elif message['LifecycleTransition'] == "autoscaling:EC2_INSTANCE_TERMINATING" or message['LifecycleTransition'] == "autoscaling:EC2_INSTANCE_LAUNCH_ERROR":
        operation = "DELETE"
    else:
        logger.error("Encountered unknown event type: %s",
                     message['LifecycleTransition'])

    asg_name = message['AutoScalingGroupName']
    instance_id = message['EC2InstanceId']

    zone_id = os.environ['HostedZoneId']
    hostname = os.environ['HostDns']

    if operation == "UPSERT":
        public_ip = fetch_public_ip_from_ec2(instance_id)
    else:
        public_ip = fetch_public_ip_from_route53(hostname, zone_id)

    update_record(zone_id, public_ip, hostname, operation)

# Picks out the message from a SNS message and deserializes it


def process_record(record):
    process_message(json.loads(record['Sns']['Message']))

# Main handler where the SNS events end up to
# Events are bulked up, so process each Record individually


def lambda_handler(event, context):
    logger.info("Processing SNS event: " + json.dumps(event))

    for record in event['Records']:
        process_record(record)

# Finish the asg lifecycle operation by sending a continue result
    logger.info("Finishing ASG action")
    message = json.loads(record['Sns']['Message'])
    if LIFECYCLE_KEY in message and ASG_KEY in message:
        response = autoscaling.complete_lifecycle_action(
            LifecycleHookName=message['LifecycleHookName'],
            AutoScalingGroupName=message['AutoScalingGroupName'],
            InstanceId=message['EC2InstanceId'],
            LifecycleActionToken=message['LifecycleActionToken'],
            LifecycleActionResult='CONTINUE'
        )
        logger.info("ASG action complete: %s", response)
    else:
        logger.error("No valid JSON message")


# if invoked manually, assume someone pipes in a event json
if __name__ == "__main__":
    logging.basicConfig()

    lambda_handler(json.load(sys.stdin), None)
