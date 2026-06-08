// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package software.amazon.edc.extensions.controlplane.ddb.types

import com.fasterxml.jackson.databind.ObjectMapper
import org.eclipse.edc.policy.model.Duty
import org.eclipse.edc.policy.model.Permission
import org.eclipse.edc.policy.model.Policy
import org.eclipse.edc.policy.model.PolicyType
import org.eclipse.edc.policy.model.Prohibition
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbAttribute
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey
import software.amazon.edc.extensions.common.ddb.EntityType
import software.amazon.edc.extensions.common.ddb.ListOfMapsConverter
import software.amazon.edc.extensions.common.ddb.MapStringAnyConverter
import software.amazon.edc.extensions.common.ddb.utility.convertValueToMapStringAny
import org.eclipse.edc.connector.controlplane.policy.spi.PolicyDefinition as EdcPolicyDefinition

@DynamoDbBean
data class PolicyDefinition(
    @get:DynamoDbPartitionKey
    @get:DynamoDbAttribute("pk")
    var pk: String = EntityType.POLICY_DEFINITION,
    @get:DynamoDbSortKey
    @get:DynamoDbAttribute("sk")
    var sk: String = "",
    @get:DynamoDbAttribute(CREATED_AT)
    var createdAt: Long = 0,
    @get:DynamoDbAttribute(ASSIGNEE)
    var assignee: String? = null,
    @get:DynamoDbAttribute(ASSIGNER)
    var assigner: String? = null,
    @get:DynamoDbAttribute(DUTIES)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var duties: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(EXTENSIBLE_PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var extensibleProperties: Map<String, Any>? = null,
    @get:DynamoDbAttribute(INHERITS_FROM)
    var inheritsFrom: String? = null,
    @get:DynamoDbAttribute(PERMISSIONS)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var permissions: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(POLICY_TYPE)
    var policyType: String = "",
    @get:DynamoDbAttribute(PRIVATE_PROPERTIES)
    @get:DynamoDbConvertedBy(MapStringAnyConverter::class)
    var privateProperties: Map<String, Any>? = null,
    @get:DynamoDbAttribute(PROFILES)
    var profiles: List<String>? = null,
    @get:DynamoDbAttribute(PROHIBITIONS)
    @get:DynamoDbConvertedBy(ListOfMapsConverter::class)
    var prohibitions: List<Map<String, Any>>? = null,
    @get:DynamoDbAttribute(TARGET)
    var target: String? = null,
) {
    val id: String get() = sk

    fun toEdcPolicyDefinition(objectMapper: ObjectMapper): EdcPolicyDefinition =
        EdcPolicyDefinition.Builder
            .newInstance()
            .apply {
                id(sk)
                createdAt(createdAt)
                policy(
                    Policy.Builder
                        .newInstance()
                        .apply {
                            assignee(assignee)
                            assigner(assigner)
                            duties(duties?.map { objectMapper.convertValue(it, Duty::class.java) })
                            extensibleProperties(extensibleProperties)
                            inheritsFrom(inheritsFrom)
                            permissions(permissions?.map { objectMapper.convertValue(it, Permission::class.java) })
                            profiles(profiles ?: emptyList())
                            type(PolicyType.valueOf(policyType))
                            prohibitions(prohibitions?.map { objectMapper.convertValue(it, Prohibition::class.java) })
                            target(target)
                        }.build(),
                )
                privateProperties(privateProperties)
            }.build()

    companion object {
        const val ASSIGNEE = "assignee"
        const val ASSIGNER = "assigner"
        const val CREATED_AT = "createdAt"
        const val DUTIES = "duties"
        const val EXTENSIBLE_PROPERTIES = "extensibleProperties"
        const val INHERITS_FROM = "inheritsFrom"
        const val PERMISSIONS = "permissions"
        const val POLICY_TYPE = "policyType"
        const val PRIVATE_PROPERTIES = "privateProperties"
        const val PROFILES = "profiles"
        const val PROHIBITIONS = "prohibitions"
        const val TARGET = "target"
    }
}

fun EdcPolicyDefinition.toDdbPolicyDefinition(objectMapper: ObjectMapper): PolicyDefinition =
    PolicyDefinition(
        pk = EntityType.POLICY_DEFINITION,
        sk = id,
        createdAt = createdAt,
        assignee = policy.assignee,
        assigner = policy.assigner,
        duties = policy.obligations.map { objectMapper.convertValueToMapStringAny(it) },
        extensibleProperties = policy.extensibleProperties,
        inheritsFrom = policy.inheritsFrom,
        permissions = policy.permissions.map { objectMapper.convertValueToMapStringAny(it) },
        policyType = policy.type.toString(),
        privateProperties = privateProperties,
        profiles = policy.profiles?.let { if (it.isEmpty()) null else it },
        prohibitions = policy.prohibitions.map { objectMapper.convertValueToMapStringAny(it) },
        target = policy.target,
    )
